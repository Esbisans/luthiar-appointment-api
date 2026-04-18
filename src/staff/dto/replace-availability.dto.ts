import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AvailabilityItemDto } from './availability-item.dto.js';

export class ReplaceAvailabilityDto {
  @ApiProperty({
    type: [AvailabilityItemDto],
    description:
      'Full weekly availability. At most one entry per dayOfWeek (enforced by unique constraint).',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityItemDto)
  items!: AvailabilityItemDto[];
}
