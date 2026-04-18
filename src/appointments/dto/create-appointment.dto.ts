import {
  IsEnum,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType } from '../../generated/prisma/enums.js';

class InlineCustomerDto {
  @ApiProperty({ example: '+525512345678' })
  @IsString()
  phone!: string;

  @ApiPropertyOptional({ example: 'Ana García' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class CreateAppointmentDto {
  @ApiPropertyOptional({
    description:
      'Existing customer id. If omitted, `customer` must be provided (inline find-or-create by phone).',
  })
  @ValidateIf((o: CreateAppointmentDto) => !o.customer)
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description:
      'Inline find-or-create by phone — used by voice / WhatsApp / chat agents.',
    type: InlineCustomerDto,
  })
  @ValidateIf((o: CreateAppointmentDto) => !o.customerId)
  @ValidateNested()
  @Type(() => InlineCustomerDto)
  customer?: InlineCustomerDto;

  @ApiProperty()
  @IsUUID()
  staffId!: string;

  @ApiProperty()
  @IsUUID()
  serviceId!: string;

  @ApiProperty({
    example: '2026-04-20T10:00:00-06:00',
    description:
      'ISO-8601 with offset. Server normalizes to UTC; the end is derived from the service duration (or StaffService.customDuration if set).',
  })
  @IsISO8601({ strict: true })
  startTime!: string;

  @ApiProperty({ enum: ChannelType })
  @IsEnum(ChannelType)
  channel!: ChannelType;

  @ApiPropertyOptional({
    description:
      'If true, skip the pending state and create as CONFIRMED (voice agent default).',
    default: false,
  })
  @IsOptional()
  autoConfirm?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Free-form channel context (caller number, widget URL, etc).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Opaque metadata blob.' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
