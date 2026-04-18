import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service.js';
import {
  GetAvailabilityQueryDto,
  GetNextSlotsQueryDto,
} from './dto/get-availability.query.dto.js';
import {
  AvailabilityResponse,
  NextSlotsResponse,
} from './dto/availability-response.dto.js';

@ApiTags('availability')
@ApiBearerAuth()
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  @Get()
  @ApiOperation({
    summary: 'Compute available slots for a service',
    description:
      'Returns free slots grouped by date. Supports multi-window business hours, per-staff availability, blocked times, holidays, buffers, and DST-aware timezone math. Max range: 31 days.',
  })
  @ApiOkResponse({ type: AvailabilityResponse })
  get(@Query() query: GetAvailabilityQueryDto) {
    return this.svc.get(query);
  }

  @Get('next')
  @ApiOperation({
    summary: 'Get the next N available slots',
    description:
      'Companion endpoint for voice / chat agents: "¿cuándo es lo más pronto?". Returns a flat list of the next `limit` slots within `lookaheadDays`.',
  })
  @ApiOkResponse({ type: NextSlotsResponse })
  getNext(@Query() query: GetNextSlotsQueryDto) {
    return this.svc.getNext(query);
  }
}
