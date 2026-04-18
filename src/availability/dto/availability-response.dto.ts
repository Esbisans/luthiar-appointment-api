import { ApiProperty } from '@nestjs/swagger';

/**
 * Response contract for /availability and /availability/next.
 *
 * Times in the response are ISO-8601 strings with an offset matching the
 * requested `timezone` (or business timezone by default), so clients never
 * have to convert again. Dates (`YYYY-MM-DD`) are also in that timezone.
 *
 * Classes (not interfaces) so `@nestjs/swagger` can serialise them into
 * the OpenAPI spec — which `openapi-typescript` then turns into typed
 * paths on the frontend. Plain interfaces are invisible at runtime and
 * produce `any` in the generated client.
 */

export type DayStatus = 'open' | 'closed' | 'holiday' | 'past';

export class SlotDto {
  @ApiProperty({ description: 'ISO-8601 with offset.' })
  start!: string;

  @ApiProperty({ required: false, description: 'Present only when format=range.' })
  end?: string;

  @ApiProperty({
    type: [String],
    description: 'Staff candidates that can take the slot. Always length ≥ 1.',
  })
  staffIds!: string[];
}

export class DaySlotsDto {
  @ApiProperty({ enum: ['open', 'closed', 'holiday', 'past'] })
  status!: DayStatus;

  @ApiProperty({ type: [SlotDto] })
  slots!: SlotDto[];
}

export class AvailabilityServiceDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Service duration in minutes.' })
  duration!: number;
}

export class AvailabilityResponse {
  @ApiProperty()
  timezone!: string;

  @ApiProperty({ type: AvailabilityServiceDto })
  service!: AvailabilityServiceDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/DaySlotsDto' },
    description: 'Map of YYYY-MM-DD → slots for that day.',
  })
  days!: Record<string, DaySlotsDto>;
}

export class NextSlotsResponse {
  @ApiProperty()
  timezone!: string;

  @ApiProperty({ type: AvailabilityServiceDto })
  service!: AvailabilityServiceDto;

  @ApiProperty({ type: [SlotDto] })
  slots!: SlotDto[];
}
