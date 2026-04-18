import {
  IsString,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateServiceDto {
  @ApiProperty({ example: 'Limpieza dental' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'Limpieza profunda con ultrasonido' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 30, description: 'Duration in minutes' })
  @IsInt()
  @Min(5)
  duration!: number;

  @ApiProperty({ example: 500.0 })
  @IsNumber()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({ example: 'MXN' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: 0, description: 'Buffer minutes before' })
  @IsOptional()
  @IsInt()
  @Min(0)
  bufferBefore?: number;

  @ApiPropertyOptional({ example: 0, description: 'Buffer minutes after' })
  @IsOptional()
  @IsInt()
  @Min(0)
  bufferAfter?: number;

  @ApiPropertyOptional({
    example: 15,
    default: 15,
    description:
      'Slot grid step in minutes. Bookings must start at multiples of this (anchored to each business-hour window\'s start). Typical values: 5, 10, 15, 30, 60. Defaults to 15.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  slotIntervalMin?: number;
}
