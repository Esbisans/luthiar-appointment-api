import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Refresh DTO is fully optional because the token usually arrives via
 * the `refresh_token` HttpOnly cookie set by /auth/login. Mobile / API
 * callers (`x-client: mobile`) include the field; web callers omit it.
 */
export class RefreshDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
