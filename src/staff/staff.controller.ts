import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  DefaultValuePipe,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';
import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { StaffService } from './staff.service.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { UpdateStaffDto } from './dto/update-staff.dto.js';
import { ListStaffQueryDto } from './dto/list-staff-query.dto.js';
import { AssignServiceDto } from './dto/assign-service.dto.js';
import { ReplaceServicesDto } from './dto/replace-services.dto.js';
import { ReplaceAvailabilityDto } from './dto/replace-availability.dto.js';
import { InviteStaffDto } from './dto/invite-staff.dto.js';

@ApiTags('staff')
@ApiBearerAuth()
@Controller('staff')
@UseInterceptors(AuditInterceptor)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  // ── CRUD ─────────────────────────────────────────────────────────────

  @Post()
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.created', targetType: 'staff', targetIdFrom: 'responseId' })
  @ApiOperation({ summary: 'Create a staff member' })
  create(@Body() dto: CreateStaffDto) {
    return this.staff.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List staff' })
  findAll(@Query() query: ListStaffQueryDto) {
    return this.staff.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a staff member by id',
    description:
      'Use ?expand=services,availability,blockedTimes,user to embed relations.',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('expand') expand?: string,
  ) {
    return this.staff.findOne(id, expand);
  }

  @Patch(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.updated', targetType: 'staff' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staff.update(id, dto);
  }

  @Delete(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.deleted', targetType: 'staff' })
  @ApiOperation({
    summary: 'Soft-delete a staff member',
    description:
      'Fails with 409 if the staff has future appointments. Pass ?force=true to cancel them in the same tx.',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force', new DefaultValuePipe(false), ParseBoolPipe) force: boolean,
  ) {
    return this.staff.remove(id, force);
  }

  // ── Service assignments (nested) ─────────────────────────────────────

  @Get(':id/services')
  listServices(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.listServices(id);
  }

  @Post(':id/services')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.service_assigned', targetType: 'staff' })
  assignService(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignServiceDto,
  ) {
    return this.staff.assignService(id, dto);
  }

  @Put(':id/services')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.services_replaced', targetType: 'staff' })
  @ApiOperation({ summary: 'Replace the full set of services for a staff' })
  replaceServices(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceServicesDto,
  ) {
    return this.staff.replaceServices(id, dto);
  }

  @Delete(':id/services/:serviceId')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.service_removed', targetType: 'staff' })
  removeService(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ) {
    return this.staff.removeService(id, serviceId);
  }

  // ── Availability (nested) ────────────────────────────────────────────

  @Get(':id/availability')
  listAvailability(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.listAvailability(id);
  }

  @Put(':id/availability')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.availability_replaced', targetType: 'staff' })
  @ApiOperation({ summary: 'Replace the full weekly availability' })
  replaceAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceAvailabilityDto,
  ) {
    return this.staff.replaceAvailability(id, dto);
  }

  // ── Invite (stub) ────────────────────────────────────────────────────

  @Post(':id/invite')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'staff.invited', targetType: 'staff' })
  @ApiOperation({
    summary: 'Invite a staff to the dashboard (stub)',
    description:
      'Returns a generated invitationId. Email + magic-link flow is not yet implemented — see docs/deferred-work.md.',
  })
  invite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteStaffDto,
  ) {
    return this.staff.invite(id, dto);
  }
}
