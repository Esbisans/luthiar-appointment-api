import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreateHolidayDto } from './create-holiday.dto.js';

export class BulkHolidaysDto {
  @ApiProperty({ type: [CreateHolidayDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateHolidayDto)
  items!: CreateHolidayDto[];
}
