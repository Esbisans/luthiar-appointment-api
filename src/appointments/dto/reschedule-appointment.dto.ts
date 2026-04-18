import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RescheduleAppointmentDto {
  @ApiProperty({
    example: '2026-04-22T11:00:00-06:00',
    description:
      'New start time. ISO-8601 with offset. End is re-derived from the service duration.',
  })
  @IsISO8601({ strict: true })
  startTime!: string;

  @ApiPropertyOptional({
    description:
      'Override the staff for the new appointment. Defaults to the same staff as the source.',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
