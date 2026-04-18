import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CancelAppointmentDto {
  @ApiPropertyOptional({
    example: 'customer_request',
    description:
      'Free-form tag for analytics. Common values: customer_request, business_closed, no_show, staff_removed.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
