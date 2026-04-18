import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BusinessHourItemDto } from './business-hour-item.dto.js';

export class ReplaceBusinessHoursDto {
  @ApiProperty({
    type: [BusinessHourItemDto],
    description:
      'Full weekly schedule. Multiple intervals per day allowed (e.g. 09:00-14:00 and 16:00-20:00). Omitted days default to closed.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BusinessHourItemDto)
  items!: BusinessHourItemDto[];
}
