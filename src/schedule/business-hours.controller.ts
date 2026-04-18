import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';
import { BusinessHoursService } from './business-hours.service.js';
import { ReplaceBusinessHoursDto } from './dto/replace-business-hours.dto.js';

@ApiTags('business-hours')
@ApiBearerAuth()
@Controller('business-hours')
export class BusinessHoursController {
  constructor(private readonly svc: BusinessHoursService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the weekly schedule',
    description:
      'Always returns one entry per day (MON→SUN); days with no hours return synthesized `isOpen: false`. Multiple intervals for the same day appear as separate rows.',
  })
  getAll() {
    return this.svc.getAll();
  }

  @Put()
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @ApiOperation({
    summary: 'Replace the full weekly schedule',
    description:
      'Supports multiple intervals per day (e.g. 09:00-14:00 and 16:00-20:00). Cross-midnight intervals are rejected (see docs/deferred-work.md D21).',
  })
  replaceAll(@Body() dto: ReplaceBusinessHoursDto) {
    return this.svc.replaceAll(dto);
  }
}
