import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AssignServiceDto } from './assign-service.dto.js';

export class ReplaceServicesDto {
  @ApiProperty({ type: [AssignServiceDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AssignServiceDto)
  items!: AssignServiceDto[];
}
