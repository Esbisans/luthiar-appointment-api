import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto.js';

export class ListStaffQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter by active status.',
    type: Boolean,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Only staff assigned to this service.',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({
    description: 'Case-insensitive match on name or email.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated list of relations to expand. Supported: services, availability, blockedTimes, user',
    example: 'services,availability',
  })
  @IsOptional()
  @IsString()
  expand?: string;
}
