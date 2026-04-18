import { IsEmail, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client.js';

export class InviteStaffDto {
  @ApiProperty({ example: 'ana@clinica.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ enum: UserRole, default: 'STAFF' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
