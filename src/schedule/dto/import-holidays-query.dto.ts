import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class ImportHolidaysQueryDto {
  @ApiProperty({
    example: 'MX',
    description: 'ISO 3166-1 alpha-2 country code (e.g. MX, US, ES).',
  })
  @IsString()
  @Length(2, 2)
  country!: string;

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(9999)
  year!: number;
}
