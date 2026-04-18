import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GetAvailabilityQueryDto {
  @ApiProperty({ description: 'Service UUID (defines duration + buffers).' })
  @IsUUID()
  serviceId!: string;

  @ApiProperty({
    example: '2026-04-20',
    description: 'Start date (YYYY-MM-DD), interpreted in business timezone.',
  })
  @IsString()
  @Matches(ISO_DATE, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-04-26',
    description: 'End date (YYYY-MM-DD), inclusive. Max range: 31 days.',
  })
  @IsString()
  @Matches(ISO_DATE, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  @ApiPropertyOptional({
    description:
      'Restrict to this staff. Omit to aggregate over all staff that can do the service ("any staff").',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description:
      'IANA timezone for the response. Defaults to the business timezone.',
    example: 'America/Mexico_City',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Slot grid step in minutes. Default = min(service.duration, 30).',
    example: 15,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(120)
  granularity?: number;

  @ApiPropertyOptional({
    description: 'time = start only; range = start + end.',
    enum: ['time', 'range'],
    default: 'time',
  })
  @IsOptional()
  @IsIn(['time', 'range'])
  format?: 'time' | 'range';
}

export class GetNextSlotsQueryDto {
  @ApiProperty()
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description: 'Max number of upcoming slots to return. Default 5, max 50.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    description: 'How many days ahead to search. Default 14, max 31.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  lookaheadDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;
}
