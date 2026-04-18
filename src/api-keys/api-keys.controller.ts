import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/enums.js';
import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { ApiKeysService } from './api-keys.service.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { RotateApiKeyDto } from './dto/rotate-api-key.dto.js';

/**
 * API Key admin endpoints — OWNER only.
 *
 * Plaintext keys are returned exactly once: in the response of `POST`
 * and `POST /:id/rotate`. There is no way to recover a key after that
 * — the only options are revoke + create.
 */
@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('api-keys')
@Roles([UserRole.OWNER])
@UseInterceptors(AuditInterceptor)
export class ApiKeysController {
  constructor(private readonly svc: ApiKeysService) {}

  @Post()
  @Audit({ action: 'api_key.created', targetType: 'api_key', targetIdFrom: 'responseId' })
  @ApiOperation({
    summary: 'Mint a new API key',
    description:
      'Returns the plaintext key ONCE. Store it immediately — it cannot be retrieved later.',
  })
  create(@Body() dto: CreateApiKeyDto, @Req() req: Request) {
    return this.svc.create(dto, req.user?.userId);
  }

  @Get()
  @ApiOperation({ summary: 'List all keys for the tenant (redacted)' })
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Delete(':id')
  @HttpCode(200)
  @Audit({ action: 'api_key.revoked', targetType: 'api_key' })
  @ApiOperation({
    summary: 'Revoke (soft-delete) a key',
    description:
      'Stops authenticating immediately. Row is preserved for forensics (lastUsedIp, callCount, revokedAt).',
  })
  revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.svc.revoke(id, req.user?.userId);
  }

  @Post(':id/rotate')
  @Audit({ action: 'api_key.rotated', targetType: 'api_key' })
  @ApiOperation({
    summary: 'Rotate with grace period',
    description:
      'Mints a new key and shortens the OLD key to `graceSeconds` (default 1h, max 7d) so deployments can swap with zero downtime.',
  })
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RotateApiKeyDto,
    @Req() req: Request,
  ) {
    return this.svc.rotate(id, dto, req.user?.userId);
  }
}
