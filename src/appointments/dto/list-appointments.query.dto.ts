import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import {
  AppointmentStatus,
  ChannelType,
} from '../../generated/prisma/enums.js';

export class ListAppointmentsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Opaque cursor from the previous response\'s `next_cursor`. Preferred over `page`. When supplied, response shape becomes `{data, has_more, next_cursor}`.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Start of time window (ISO).' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End of time window (ISO, exclusive).' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated statuses, e.g. PENDING,CONFIRMED',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? (value.split(',').map((s) => s.trim()) as AppointmentStatus[])
      : value,
  )
  @IsArray()
  @IsEnum(AppointmentStatus, { each: true })
  status?: AppointmentStatus[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({ enum: ChannelType })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional({
    description:
      'Expandable relations: customer, staff, service (comma-separated).',
    example: 'customer,staff,service',
  })
  @IsOptional()
  @IsString()
  expand?: string;
}
