import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Ana García' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: '+525512345678',
    description:
      'E.164 preferred. Any reasonable input is normalized server-side.',
  })
  @IsString()
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ example: 'ana@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'VIP — prefers afternoons.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
