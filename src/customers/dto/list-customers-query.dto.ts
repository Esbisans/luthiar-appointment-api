import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto.js';

export class ListCustomersQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Opaque cursor from the previous response\'s `next_cursor`. Preferred over `page` — when both are supplied, `cursor` wins. Response shape switches to `{data, has_more, next_cursor}` when cursor pagination is in effect.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description:
      'Fuzzy search across name, phone and email (case-insensitive).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description: 'Exact match by E.164 phone (normalized server-side).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ description: 'Exact match by email.' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated relations to embed. Supported: recentAppointments, upcomingAppointments',
    example: 'recentAppointments,upcomingAppointments',
  })
  @IsOptional()
  @IsString()
  expand?: string;
}
