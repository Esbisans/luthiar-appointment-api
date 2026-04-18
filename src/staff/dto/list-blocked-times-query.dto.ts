import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto.js';

export class ListBlockedTimesQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter by staff; omit for all (including business-wide).',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive).' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive).' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
