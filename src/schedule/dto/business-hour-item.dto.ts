import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DayOfWeek } from '../../generated/prisma/client.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class BusinessHourItemDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  @ApiProperty({ example: '14:00' })
  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Set to false for a closed day. Closed days must not have other intervals.',
  })
  @IsOptional()
  @IsBoolean()
  isOpen?: boolean;
}
