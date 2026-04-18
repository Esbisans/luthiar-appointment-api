import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

class AuditQueryDto {
  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  actorId?: string;

  @IsOptional()
  @IsEnum(['success', 'failure'])
  outcome?: 'success' | 'failure';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsUUID()
  startingAfter?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Read-only dashboard window into the audit log. Writes happen via
 * `AuditInterceptor` only — there is no `POST /audit`. Append-only
 * is enforced at the DB layer (REVOKE UPDATE/DELETE + trigger).
 *
 * OWNER and ADMIN roles can read; agents (API keys) cannot — the
 * audit trail is for human accountability, not agent self-inspection.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
@Roles([UserRole.OWNER, UserRole.ADMIN])
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'Query the append-only audit log',
    description:
      'Cursor-paginated. Common filters: `targetId` (history of one resource), `actorId` (everything one user did), `action` (e.g. `appointment.cancelled`).',
  })
  async findAll(@Query() q: AuditQueryDto) {
    const limit = q.limit ?? 50;
    const where: Record<string, unknown> = {};
    if (q.targetType) where['targetType'] = q.targetType;
    if (q.targetId) where['targetId'] = q.targetId;
    if (q.action) where['action'] = q.action;
    if (q.actorId) where['actorId'] = q.actorId;
    if (q.outcome) where['outcome'] = q.outcome;
    if (q.from || q.to) {
      const r: Record<string, Date> = {};
      if (q.from) r['gte'] = new Date(q.from);
      if (q.to) r['lt'] = new Date(q.to);
      where['occurredAt'] = r;
    }
    const rows = await this.prisma.db.auditEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
      ...(q.startingAfter
        ? { cursor: { id: q.startingAfter }, skip: 1 }
        : {}),
    });
    const hasMore = rows.length > limit;
    return {
      data: hasMore ? rows.slice(0, limit) : rows,
      has_more: hasMore,
    };
  }
}
