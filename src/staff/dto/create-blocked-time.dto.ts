import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBlockedTimeDto {
  @ApiPropertyOptional({
    description:
      'Staff this block applies to. Omit for business-wide blocks (e.g. public holiday, office closure).',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiProperty({ example: '2026-05-01T00:00:00Z' })
  @IsDateString()
  startTime!: string;

  @ApiProperty({ example: '2026-05-08T23:59:59Z' })
  @IsDateString()
  endTime!: string;

  @ApiPropertyOptional({ example: 'Vacaciones' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;
}
