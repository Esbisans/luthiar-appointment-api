import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SearchQueryDto {
  @ApiPropertyOptional({
    description:
      'Search query. Case-insensitive, accent-insensitive, typo-tolerant. Minimum 2 chars — shorter queries return empty results.',
    example: 'Maria',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  q?: string;

  @ApiPropertyOptional({
    description:
      'Comma-separated list of entity types to include. Defaults to all.',
    example: 'customer,appointment',
    enum: ['customer', 'appointment', 'conversation', 'staff', 'service'],
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').map((s) => s.trim()) : value,
  )
  @IsArray()
  @IsIn(['customer', 'appointment', 'conversation', 'staff', 'service'], {
    each: true,
  })
  types?: Array<
    'customer' | 'appointment' | 'conversation' | 'staff' | 'service'
  >;

  @ApiPropertyOptional({
    description: 'Max results per entity type.',
    default: 5,
    maximum: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 5;
}
