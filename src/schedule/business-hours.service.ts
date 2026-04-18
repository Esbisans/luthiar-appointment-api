import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import { ConflictError } from '../common/errors/index.js';
import { DayOfWeek } from '../generated/prisma/client.js';
import { ReplaceBusinessHoursDto } from './dto/replace-business-hours.dto.js';
import {
  DAY_ORDER,
  intervalsOverlap,
  isOrderedSameDay,
} from './utils/luxon.util.js';

const DAY_INDEX: Record<DayOfWeek, number> = {
  MONDAY: 0,
  TUESDAY: 1,
  WEDNESDAY: 2,
  THURSDAY: 3,
  FRIDAY: 4,
  SATURDAY: 5,
  SUNDAY: 6,
};

@Injectable()
export class BusinessHoursService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  /**
   * Returns the weekly schedule ordered MON→SUN. Each day appears at least
   * once: if nothing is persisted we synthesize a closed marker so the
   * dashboard renders a consistent shape. Multiple intervals per day
   * remain as multiple rows.
   */
  async getAll() {
    const rows = await this.prisma.db.businessHour.findMany({
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
    // Sort MON→SUN deterministically (DB enum order is Postgres-defined).
    rows.sort((a, b) => {
      const da = DAY_INDEX[a.dayOfWeek] ?? 99;
      const db = DAY_INDEX[b.dayOfWeek] ?? 99;
      if (da !== db) return da - db;
      return a.startTime.localeCompare(b.startTime);
    });

    // Synthesize closed markers for days with no rows — dashboard contract.
    const present = new Set(rows.map((r) => r.dayOfWeek));
    const synthesized = DAY_ORDER.filter((d) => !present.has(d)).map((d) => ({
      id: null,
      businessId: null,
      dayOfWeek: d,
      startTime: '00:00',
      endTime: '00:00',
      isOpen: false,
      synthesized: true as const,
    }));

    return [...rows, ...synthesized].sort(
      (a, b) =>
        (DAY_INDEX[a.dayOfWeek] ?? 99) - (DAY_INDEX[b.dayOfWeek] ?? 99),
    );
  }

  /**
   * Replace-all semantics. One transaction: delete every row for this
   * tenant (RLS scopes it), create the new batch. Any subsequent query in
   * the same request sees the new state.
   *
   * Validation before the write so we fail fast:
   *   • each open interval must have start < end (cross-midnight rejected)
   *   • closed days (isOpen=false) cannot also carry other rows
   *   • intervals in the same day cannot overlap
   */
  async replaceAll(dto: ReplaceBusinessHoursDto) {
    const byDay = new Map<
      DayOfWeek,
      { startTime: string; endTime: string; isOpen: boolean }[]
    >();
    for (const it of dto.items) {
      const isOpen = it.isOpen ?? true;
      if (isOpen && !isOrderedSameDay(it.startTime, it.endTime)) {
        throw new ConflictError(
          'startTime must be before endTime (cross-midnight not supported)',
          {
            dayOfWeek: it.dayOfWeek,
            startTime: it.startTime,
            endTime: it.endTime,
          },
        );
      }
      const list = byDay.get(it.dayOfWeek) ?? [];
      list.push({ startTime: it.startTime, endTime: it.endTime, isOpen });
      byDay.set(it.dayOfWeek, list);
    }

    for (const [day, list] of byDay) {
      const closed = list.filter((l) => !l.isOpen);
      const open = list.filter((l) => l.isOpen);
      if (closed.length > 0 && (open.length > 0 || closed.length > 1)) {
        throw new ConflictError(
          `${day} has both closed marker and other intervals — choose one`,
          { dayOfWeek: day },
        );
      }
      // Overlap check among open intervals of the same day.
      for (let i = 0; i < open.length; i++) {
        for (let j = i + 1; j < open.length; j++) {
          const a = open[i]!;
          const b = open[j]!;
          if (
            intervalsOverlap(
              { start: a.startTime, end: a.endTime },
              { start: b.startTime, end: b.endTime },
            )
          ) {
            throw new ConflictError(
              `${day} has overlapping intervals`,
              { dayOfWeek: day, a, b },
            );
          }
        }
      }
    }

    await this.prisma.db.businessHour.deleteMany({});
    if (dto.items.length > 0) {
      await this.prisma.db.businessHour.createMany({
        data: dto.items.map((it) => ({
          dayOfWeek: it.dayOfWeek,
          startTime: it.startTime,
          endTime: it.endTime,
          isOpen: it.isOpen ?? true,
        })) as never,
      });
    }
    return this.getAll();
  }
}
