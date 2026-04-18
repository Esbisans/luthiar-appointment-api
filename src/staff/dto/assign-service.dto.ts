import {
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignServiceDto {
  @ApiProperty()
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({
    description: 'Override the default service duration for this staff.',
    example: 45,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  customDuration?: number;

  @ApiPropertyOptional({
    description: 'Override the default service price for this staff.',
    example: 700,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  customPrice?: number;
}
