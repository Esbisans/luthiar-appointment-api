import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/enums.js';
import { AppointmentsService } from './appointments.service.js';
import { CreateAppointmentDto } from './dto/create-appointment.dto.js';
import { UpdateAppointmentDto } from './dto/update-appointment.dto.js';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto.js';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto.js';
import { ListAppointmentsQueryDto } from './dto/list-appointments.query.dto.js';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor.js';
import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';

@ApiTags('appointments')
@ApiBearerAuth()
@Controller('appointments')
@UseInterceptors(AuditInterceptor)
export class AppointmentsController {
  constructor(private readonly appts: AppointmentsService) {}

  // ── CRUD ────────────────────────────────────────────────────────────

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.created', targetType: 'appointment', targetIdFrom: 'responseId' })
  @ApiOperation({
    summary: 'Create an appointment',
    description:
      'Idempotency-Key header is REQUIRED for API-key callers (voice / WhatsApp / chat), OPTIONAL for dashboard JWT.',
  })
  create(@Body() dto: CreateAppointmentDto) {
    return this.appts.create(dto);
  }

  @Get()
  findAll(@Query() query: ListAppointmentsQueryDto) {
    return this.appts.findAll(query);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('expand') expand?: string,
  ) {
    return this.appts.findOne(id, expand);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update notes / metadata',
    description:
      'Status changes go via POST /:id/{confirm|check-in|complete|no-show|cancel}. Time changes via POST /:id/reschedule.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentDto,
  ) {
    return this.appts.update(id, dto);
  }

  @Delete(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.remove(id);
  }

  // ── State transitions ──────────────────────────────────────────────
  //
  // All five transitions are guarded by `IdempotencyInterceptor` because
  // voice / WhatsApp agents retry on network drops. A retried "cancel"
  // must NOT toggle state or fail with 409 — the interceptor returns the
  // cached response from the first attempt within the 24h TTL, and the
  // service-level state machine handles same-state transitions
  // gracefully (returns the current state instead of throwing).

  @Post(':id/confirm')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.confirmed', targetType: 'appointment' })
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.confirm(id);
  }

  @Post(':id/check-in')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.checked_in', targetType: 'appointment' })
  checkIn(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.checkIn(id);
  }

  @Post(':id/complete')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.completed', targetType: 'appointment' })
  complete(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.complete(id);
  }

  @Post(':id/no-show')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.no_show', targetType: 'appointment' })
  noShow(@Param('id', ParseUUIDPipe) id: string) {
    return this.appts.noShow(id);
  }

  @Post(':id/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.cancelled', targetType: 'appointment' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    return this.appts.cancel(id, dto, 'business');
  }

  @Post(':id/reschedule')
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({ action: 'appointment.rescheduled', targetType: 'appointment' })
  @ApiOperation({
    summary: 'Reschedule — cancels the existing appointment and creates a new one linked by rescheduledFromId.',
  })
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleAppointmentDto,
  ) {
    return this.appts.reschedule(id, dto);
  }
}
