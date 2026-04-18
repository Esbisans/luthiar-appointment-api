import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'Consultorio Dental Sonrisa' })
  @IsString()
  businessName!: string;

  @ApiProperty({ example: 'consultorio-dental-sonrisa' })
  @IsString()
  slug!: string;

  @ApiProperty({ example: 'Dr. Juan García' })
  @IsString()
  name!: string;

  @ApiProperty({ example: 'juan@clinica.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;
}
