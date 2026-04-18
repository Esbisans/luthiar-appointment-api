import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RotateApiKeyDto {
  @ApiProperty({
    description:
      'Seconds until the OLD key stops working (overlap window). Default 3600 (1h). Max 7 days.',
    example: 3600,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7 * 24 * 3600)
  graceSeconds?: number;
}
