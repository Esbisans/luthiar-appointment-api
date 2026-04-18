import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Used by the voice / WhatsApp agent on inbound contact. Phone is required;
 * name is optional because the agent may not know it yet — if the customer
 * is new, we record "Unknown" and let the agent update it later.
 */
export class FindOrCreateCustomerDto {
  @ApiProperty({ example: '+525512345678' })
  @IsString()
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ example: 'Ana García' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}
