import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListHolidaysQueryDto {
  @ApiPropertyOptional({ description: 'Filter by calendar year (e.g. 2026).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(9999)
  year?: number;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive), ISO date.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive), ISO date.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
