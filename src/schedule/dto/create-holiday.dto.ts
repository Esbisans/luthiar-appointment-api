import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateHolidayDto {
  @ApiProperty({
    example: '2026-12-25',
    description:
      'ISO date (YYYY-MM-DD). Holidays are whole-day and timezone-independent.',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 'Navidad' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'If true, the date repeats every year (match by month-day). Set false for one-off closures.',
  })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
