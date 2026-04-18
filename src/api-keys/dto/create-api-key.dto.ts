import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateApiKeyDto {
  @ApiProperty({
    description:
      'Human-readable label shown in the dashboard (e.g. "voice-agent-prod").',
    example: 'voice-agent-prod',
  })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description:
      'Stripe-style key environment. `live` (default) mints `agnt_live_*` and writes to the production partition; `test` mints `agnt_test_*` and writes to the test partition — the same codebase, different RLS-isolated row set.',
    enum: ['live', 'test'],
    default: 'live',
    required: false,
  })
  @IsOptional()
  @IsEnum(['live', 'test'])
  mode?: 'live' | 'test';

  @ApiProperty({
    description:
      'Optional ISO-8601 expiry. If omitted the key never expires (revoke manually).',
    example: '2027-01-01T00:00:00Z',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
