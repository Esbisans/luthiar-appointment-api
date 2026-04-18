import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors/index.js';
import {
  AppointmentStatus,
  ChannelType,
} from '../generated/prisma/enums.js';
import { CustomersService } from '../customers/customers.service.js';
import { QueueProducer } from '../queues/producers/queue.producer.js';
import { QueueName } from '../queues/queue-names.js';
import {
  cursorWhere,
  decodeCursor,
  keysetOrderBy,
  slicePage,
  takePlusOne,
} from '../common/pagination/cursor.util.js';
import {
  utcMsToIsoWithOffset,
  weekdayOfDate,
  windowToUtcInterval,
} from '../availability/engine/slot-grid.util.js';

/**
 * Grace window absorbed when the caller submits a `startTime` that's
 * "now-ish". 30 s is evidence-based for voice / chat agents where the
 * STT → LLM → tool-call pipeline can easily take 1-3 s plus network, so
 * a `Date.now()` computed client-side arrives already 1-5 s in the past.
 * Stricter than the Stripe webhook 5-min tolerance; well above NTP drift.
 */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;
import { CreateAppointmentDto } from './dto/create-appointment.dto.js';
import { UpdateAppointmentDto } from './dto/update-appointment.dto.js';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto.js';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto.js';
import { ListAppointmentsQueryDto } from './dto/list-appointments.query.dto.js';
import { assertCanTransition } from './state/appointment-state.js';
import { AppointmentEvents } from './events/appointment.events.js';
import { OutboxService } from './events/outbox.service.js';

const EXCLUSION_VIOLATION_SQLSTATE = '23P01';

@Injectable()
export class AppointmentsService extends BaseTenantService {
  constructor(
    prisma: PrismaService,
    cls: ClsService,
    private readonly customers: CustomersService,
    private readonly outbox: OutboxService,
    private readonly queues: QueueProducer,
  ) {
    super(prisma, cls);
  }

  // ── Reminder scheduling ────────────────────────────────────────────

  private reminderJobId(appointmentId: string, kind: '24h' | '1h'): string {
    return `reminder-${kind}-${appointmentId}`;
  }

  private async scheduleReminders(appointmentId: string, startTime: Date): Promise<void> {
    const now = Date.now();
    const start = startTime.getTime();
    const windows: Array<{ kind: '24h' | '1h'; minutesBefore: number; name: string }> = [
      { kind: '24h', minutesBefore: 24 * 60, name: 'send-reminder-24h' },
      { kind: '1h', minutesBefore: 60, name: 'send-reminder-1h' },
    ];
    for (const w of windows) {
      const fireAt = start - w.minutesBefore * 60_000;
      if (fireAt <= now) continue;
      await this.queues.enqueue(QueueName.Notifications, w.name, { appointmentId }, {
        jobId: this.reminderJobId(appointmentId, w.kind),
        delay: fireAt - now,
        attempts: 3,
      });
    }
  }

  private async cancelReminders(appointmentId: string): Promise<void> {
    await Promise.all([
      this.queues.remove(QueueName.Notifications, this.reminderJobId(appointmentId, '24h')),
      this.queues.remove(QueueName.Notifications, this.reminderJobId(appointmentId, '1h')),
    ]);
  }

  // ── Create ──────────────────────────────────────────────────────────

  async create(dto: CreateAppointmentDto) {
    let customerId = dto.customerId;
    if (!customerId) {
      if (!dto.customer) {
        throw new ValidationError(
          'Either customerId or customer (inline) must be provided',
          [{ field: 'customerId', code: 'required' }],
        );
      }
      const result = await this.customers.findOrCreate({
        phone: dto.customer.phone,
        name: dto.customer.name,
      });
      customerId = result.customer.id;
    }

    const [staff, service, staffService] = await Promise.all([
      this.prisma.db.staff.findFirst({
        where: { id: dto.staffId, deletedAt: null, isActive: true },
        select: { id: true },
      }),
      this.prisma.db.service.findFirst({
        where: { id: dto.serviceId, deletedAt: null, isActive: true },
        select: { id: true, duration: true, slotIntervalMin: true },
      }) as Promise<{ id: string; duration: number; slotIntervalMin: number } | null>,
      this.prisma.db.staffService.findFirst({
        where: { staffId: dto.staffId, serviceId: dto.serviceId },
        select: { customDuration: true },
      }),
    ]);
    if (!staff) throw new NotFoundError('Staff not found', [{ field: 'staffId', code: 'not_found' }]);
    if (!service) throw new NotFoundError('Service not found', [{ field: 'serviceId', code: 'not_found' }]);
    if (!staffService) {
      throw new ConflictError('Staff does not offer this service', { staffId: dto.staffId, serviceId: dto.serviceId });
    }

    const durationMin = staffService.customDuration ?? service.duration;
    const startUtc = DateTime.fromISO(dto.startTime, { setZone: true });
    if (!startUtc.isValid) {
      throw new ValidationError('startTime is not a valid ISO-8601 with offset', [{ field: 'startTime', code: 'invalid_iso' }]);
    }
    const startDate = startUtc.toJSDate();
    const endDate = startUtc.plus({ minutes: durationMin }).toJSDate();

    // Past-time check with skew tolerance — see CLOCK_SKEW_TOLERANCE_MS.
    if (startUtc.toMillis() <= Date.now() - CLOCK_SKEW_TOLERANCE_MS) {
      throw new ValidationError('startTime must be in the future', [{ field: 'startTime', code: 'past' }]);
    }

    // Slot-boundary check — Cal.com / Calendly / Acuity pattern. Anchors
    // to business-hour window start (not midnight) so lunch breaks don't
    // distort the grid. Soft-skipped when the tenant has not configured
    // hours for that weekday: we don't block on data that doesn't exist.
    const slotIntervalMin = service.slotIntervalMin ?? 15;
    await this.assertOnSlotBoundary(startUtc, slotIntervalMin);

    const initialStatus = dto.autoConfirm ? AppointmentStatus.CONFIRMED : AppointmentStatus.PENDING;

    try {
      const created = await this.prisma.db.appointment.create({
        data: {
          customerId,
          staffId: dto.staffId,
          serviceId: dto.serviceId,
          status: initialStatus,
          startTime: startDate,
          endTime: endDate,
          channel: dto.channel,
          notes: dto.notes ?? null,
          source: dto.source ?? null,
          metadata: (dto.metadata ?? null) as never,
        } as never,
      });

      await this.outbox.enqueue(AppointmentEvents.Created, {
        appointmentId: created.id,
        businessId: this.businessId,
        customerId: created.customerId,
        staffId: created.staffId,
        serviceId: created.serviceId,
        startTime: created.startTime.toISOString(),
        channel: created.channel,
        toStatus: created.status,
      });

      await this.scheduleReminders(created.id, created.startTime);
      this.outbox.kickFlush();

      return created;
    } catch (e: unknown) {
      if (this.isExclusionViolation(e)) {
        throw new ConflictError('Requested slot is already taken', { staffId: dto.staffId, startTime: dto.startTime });
      }
      throw e;
    }
  }

  // ── Read ─────────────────────────────────────────────────────────────

  async findAll(query: ListAppointmentsQueryDto) {
    const { page, limit = 20, from, to, status, customerId, staffId, serviceId, channel, cursor } = query;
    const baseWhere: Record<string, unknown> = { deletedAt: null };
    if (status?.length) baseWhere['status'] = { in: status };
    if (customerId) baseWhere['customerId'] = customerId;
    if (staffId) baseWhere['staffId'] = staffId;
    if (serviceId) baseWhere['serviceId'] = serviceId;
    if (channel) baseWhere['channel'] = channel;
    if (from || to) {
      const and: Record<string, unknown>[] = [];
      if (from) and.push({ startTime: { gte: new Date(from) } });
      if (to) and.push({ startTime: { lt: new Date(to) } });
      baseWhere['AND'] = and;
    }

    const expand = new Set((query.expand ?? '').split(',').map((t) => t.trim()));
    const include: Record<string, unknown> = {};
    if (expand.has('customer')) include['customer'] = { select: { id: true, name: true, phone: true } };
    if (expand.has('staff')) include['staff'] = { select: { id: true, name: true } };
    if (expand.has('service')) include['service'] = { select: { id: true, name: true, duration: true } };
    const includeArg = Object.keys(include).length > 0 ? { include } : {};

    // Cursor path — keyset by (startTime, id). Dashboard calendars read
    // newest-first by appointment date, not booking date.
    if (cursor !== undefined && cursor.length > 0) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ValidationError('Invalid cursor', [
          { field: 'cursor', code: 'invalid_cursor' },
        ]);
      }
      const where = { ...baseWhere, ...cursorWhere(decoded, 'startTime') };
      const rows = await this.prisma.db.appointment.findMany({
        where,
        orderBy: keysetOrderBy('startTime'),
        take: takePlusOne(limit),
        ...includeArg,
      });
      return slicePage(
        rows as Array<{ id: string; startTime: Date }>,
        limit,
        'startTime',
      );
    }

    // Legacy offset path (deprecated — see D81).
    const effectivePage = page ?? 1;
    const skip = (effectivePage - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.db.appointment.findMany({
        where: baseWhere, skip, take: limit, orderBy: { startTime: 'desc' },
        ...includeArg,
      }),
      this.prisma.db.appointment.count({ where: baseWhere }),
    ]);
    return { data, total, page: effectivePage, limit };
  }

  async findOne(id: string, expandRaw?: string) {
    const expand = new Set((expandRaw ?? '').split(',').map((t) => t.trim()));
    const include: Record<string, unknown> = {};
    if (expand.has('customer')) include['customer'] = { select: { id: true, name: true, phone: true } };
    if (expand.has('staff')) include['staff'] = { select: { id: true, name: true } };
    if (expand.has('service')) include['service'] = { select: { id: true, name: true, duration: true } };

    const appt = await this.prisma.db.appointment.findFirst({
      where: { id, deletedAt: null },
      ...(Object.keys(include).length > 0 ? { include } : {}),
    });
    if (!appt) {
      throw new NotFoundError('Appointment not found', [{ field: 'id', code: 'not_found', message: `No appointment with id ${id}` }]);
    }
    return appt;
  }

  // ── Update (notes / metadata only) ──────────────────────────────────

  async update(id: string, dto: UpdateAppointmentDto) {
    await this.findOne(id);
    const patch: Record<string, unknown> = {};
    if (dto.notes !== undefined) patch['notes'] = dto.notes;
    if (dto.metadata !== undefined) patch['metadata'] = dto.metadata;
    return this.prisma.db.appointment.update({ where: { id }, data: patch as never });
  }

  // ── State transitions ──────────────────────────────────────────────

  async confirm(id: string) { return this.transition(id, AppointmentStatus.CONFIRMED, AppointmentEvents.Confirmed); }
  async checkIn(id: string) { return this.transition(id, AppointmentStatus.IN_PROGRESS, AppointmentEvents.CheckedIn); }
  async complete(id: string) { return this.transition(id, AppointmentStatus.COMPLETED, AppointmentEvents.Completed); }
  async noShow(id: string) { return this.transition(id, AppointmentStatus.NO_SHOW, AppointmentEvents.NoShow); }

  private async transition(
    id: string,
    to: AppointmentStatus,
    event: (typeof AppointmentEvents)[keyof typeof AppointmentEvents],
  ) {
    const appt = await this.findOne(id);
    // Idempotent semantics: if already in the target state, return as-is.
    // This makes the endpoint safe to retry from voice / WhatsApp agents
    // without surfacing 409 just because the network swallowed the first
    // response.
    if (appt.status === to) return appt;
    assertCanTransition(appt.status, to);
    const updated = await this.prisma.db.appointment.update({ where: { id }, data: { status: to } as never });
    await this.outbox.enqueue(event, {
      appointmentId: updated.id,
      businessId: this.businessId,
      customerId: updated.customerId,
      staffId: updated.staffId,
      serviceId: updated.serviceId,
      startTime: updated.startTime.toISOString(),
      channel: updated.channel as ChannelType,
      fromStatus: appt.status,
      toStatus: to,
    });
    this.outbox.kickFlush();
    return updated;
  }

  // ── Cancel ──────────────────────────────────────────────────────────

  async cancel(id: string, dto: CancelAppointmentDto, actor: 'customer' | 'business' = 'business') {
    const appt = await this.findOne(id);
    // Idempotent: already cancelled → return as-is. Safe-retry under
    // network drops from voice/WhatsApp agents.
    if (appt.status === AppointmentStatus.CANCELLED) return appt;
    assertCanTransition(appt.status, AppointmentStatus.CANCELLED);

    if (actor === 'customer') {
      const business = await this.prisma.db.business.findFirst({
        where: { id: this.businessId },
        select: { cancellationHours: true },
      });
      const hours = business?.cancellationHours ?? 24;
      const hoursUntilStart = DateTime.fromJSDate(appt.startTime).diffNow('hours').hours;
      if (hoursUntilStart < hours) {
        throw new ValidationError(
          `Cancellation window closed (${hours}h minimum notice)`,
          [{ field: 'startTime', code: 'too_late_to_cancel', message: `starts in ${hoursUntilStart.toFixed(1)}h` }],
        );
      }
    }

    const updated = await this.prisma.db.appointment.update({
      where: { id },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: dto.reason ?? null,
        cancelledByActorType: actor,
      } as never,
    });

    await this.outbox.enqueue(AppointmentEvents.Cancelled, {
      appointmentId: updated.id,
      businessId: this.businessId,
      customerId: updated.customerId,
      staffId: updated.staffId,
      serviceId: updated.serviceId,
      startTime: updated.startTime.toISOString(),
      channel: updated.channel as ChannelType,
      fromStatus: appt.status,
      toStatus: AppointmentStatus.CANCELLED,
      cancellationReason: dto.reason ?? undefined,
    });

    await this.cancelReminders(id);
    this.outbox.kickFlush();

    return updated;
  }

  // ── Reschedule (Cal.com-style: cancel old + create new linked) ─────

  async reschedule(id: string, dto: RescheduleAppointmentDto) {
    const old = await this.findOne(id);
    assertCanTransition(old.status, AppointmentStatus.CANCELLED);

    const result = await this.create({
      customerId: old.customerId,
      staffId: dto.staffId ?? old.staffId,
      serviceId: old.serviceId,
      startTime: dto.startTime,
      channel: old.channel as ChannelType,
      notes: old.notes ?? undefined,
      autoConfirm: old.status === AppointmentStatus.CONFIRMED,
    });

    const linked = await this.prisma.db.appointment.update({
      where: { id: result.id },
      data: { rescheduledFromId: old.id } as never,
    });
    await this.prisma.db.appointment.update({
      where: { id: old.id },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: dto.reason ?? 'RESCHEDULED',
        cancelledByActorType: 'business',
      } as never,
    });

    await this.outbox.enqueue(AppointmentEvents.Rescheduled, {
      appointmentId: linked.id,
      businessId: this.businessId,
      customerId: linked.customerId,
      staffId: linked.staffId,
      serviceId: linked.serviceId,
      startTime: linked.startTime.toISOString(),
      channel: linked.channel as ChannelType,
      rescheduledFromId: old.id,
      rescheduledToId: linked.id,
    });

    await this.cancelReminders(old.id);
    this.outbox.kickFlush();

    return linked;
  }

  // ── Soft delete ─────────────────────────────────────────────────────

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.db.appointment.update({ where: { id }, data: { deletedAt: new Date() } });
    return { message: 'Appointment deleted' };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private isExclusionViolation(e: unknown): boolean {
    const err = e as { code?: string; meta?: { code?: string } };
    if (err?.code === EXCLUSION_VIOLATION_SQLSTATE) return true;
    if (err?.meta?.code === EXCLUSION_VIOLATION_SQLSTATE) return true;
    if (typeof (e as Error)?.message === 'string' && (e as Error).message.includes('appointment_no_overlap')) return true;
    return false;
  }

  /**
   * Validate `startTime` against both business-hour windows and the
   * service's slot grid. Enforcement is all-or-nothing per tenant:
   *
   *   • Tenant has **zero** `BusinessHour` rows configured at all
   *     (brand-new tenant, hasn't set up their schedule yet): skip ALL
   *     checks. Backwards compat — we can't validate what they haven't
   *     told us.
   *
   *   • Tenant has **any** `BusinessHour` rows (they've told us their
   *     schedule): enforce strictly. A tenant who sets Mon-Fri clearly
   *     doesn't want Sunday bookings — weekends with zero windows
   *     become "closed" and are rejected.
   *
   * Error codes returned (all 422 `VALIDATION_FAILED`):
   *   • `business_closed`          — day has no open windows
   *   • `outside_business_hours`   — day has windows but startTime is
   *                                  before/after/between them
   *   • `slot_boundary_mismatch`   — inside a window but off-grid;
   *                                  message surfaces nearest valid
   *                                  slots
   *
   * Grid anchor is the START of whichever window contains startTime,
   * not midnight — so a lunch break (09-14 + 16-20) keeps the
   * afternoon grid aligned.
   */
  private async assertOnSlotBoundary(
    startUtc: DateTime,
    slotIntervalMin: number,
  ): Promise<void> {
    const business = await this.prisma.db.business.findFirst({
      where: { id: this.businessId },
      select: { timezone: true },
    });
    if (!business) return;

    // Trigger: does this tenant have ANY hours? If not, skip validation
    // entirely — new tenants that haven't configured a schedule can
    // still accept bookings via API during onboarding.
    const totalHours = await this.prisma.db.businessHour.count();
    if (totalHours === 0) return;

    const businessTz = business.timezone;
    const localStart = startUtc.setZone(businessTz);
    const dateISO = localStart.toISODate();
    if (!dateISO) return;

    const weekday = weekdayOfDate(dateISO, businessTz);
    const windows = await this.prisma.db.businessHour.findMany({
      where: { dayOfWeek: weekday, isOpen: true } as never,
      orderBy: { startTime: 'asc' } as never,
      select: { startTime: true, endTime: true },
    });

    // Tenant configured a schedule, but this weekday is closed.
    if (windows.length === 0) {
      throw new ValidationError(
        'Business is closed on this day of the week',
        [{ field: 'startTime', code: 'business_closed' }],
      );
    }

    const startMs = startUtc.toMillis();
    const slotMs = slotIntervalMin * 60_000;

    let containing: { start: number; end: number } | null = null;
    for (const w of windows as Array<{ startTime: string; endTime: string }>) {
      const iv = windowToUtcInterval(
        dateISO,
        w.startTime,
        w.endTime,
        businessTz,
      );
      if (iv && startMs >= iv.start && startMs < iv.end) {
        containing = iv;
        break;
      }
    }

    // Tenant has windows for this day but startTime is not inside any.
    if (!containing) {
      const windowStrings = (windows as Array<{ startTime: string; endTime: string }>)
        .map((w) => `${w.startTime}-${w.endTime}`)
        .join(', ');
      throw new ValidationError(
        'startTime is outside business hours',
        [
          {
            field: 'startTime',
            code: 'outside_business_hours',
            message: `Open windows for this day: ${windowStrings}`,
          },
        ],
      );
    }

    const delta = startMs - containing.start;
    if (delta % slotMs !== 0) {
      const before = containing.start + Math.floor(delta / slotMs) * slotMs;
      const after = before + slotMs;
      throw new ValidationError(
        `startTime does not align with the ${slotIntervalMin}-min slot grid`,
        [
          {
            field: 'startTime',
            code: 'slot_boundary_mismatch',
            message: `Nearest valid slots: ${utcMsToIsoWithOffset(before, businessTz)} or ${utcMsToIsoWithOffset(after, businessTz)}`,
          },
        ],
      );
    }
  }
}
