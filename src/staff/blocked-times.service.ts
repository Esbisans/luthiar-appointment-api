import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import { ConflictError, NotFoundError } from '../common/errors/index.js';
import { CreateBlockedTimeDto } from './dto/create-blocked-time.dto.js';
import { ListBlockedTimesQueryDto } from './dto/list-blocked-times-query.dto.js';

@Injectable()
export class BlockedTimesService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  async findAll(query: ListBlockedTimesQueryDto) {
    const { page = 1, limit = 20, staffId, from, to } = query;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (staffId !== undefined) where['staffId'] = staffId;
    if (from || to) {
      where['AND'] = [
        from ? { endTime: { gte: new Date(from) } } : {},
        to ? { startTime: { lt: new Date(to) } } : {},
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.db.blockedTime.findMany({
        where,
        skip,
        take: limit,
        orderBy: { startTime: 'asc' },
      }),
      this.prisma.db.blockedTime.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async create(dto: CreateBlockedTimeDto) {
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (start >= end) {
      throw new ConflictError('startTime must be before endTime', {
        startTime: dto.startTime,
        endTime: dto.endTime,
      });
    }

    // If a staffId is given, validate it exists (and belongs to us — RLS
    // guarantees that, but we want a clean 404 instead of an FK error).
    if (dto.staffId) {
      const exists = await this.prisma.db.staff.findFirst({
        where: { id: dto.staffId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new NotFoundError('Staff not found', [
          {
            field: 'staffId',
            code: 'not_found',
            message: `No staff with id ${dto.staffId}`,
          },
        ]);
      }
    }

    return this.prisma.db.blockedTime.create({
      data: {
        staffId: dto.staffId ?? null,
        startTime: start,
        endTime: end,
        reason: dto.reason ?? null,
        isAllDay: dto.isAllDay ?? false,
      } as never,
    });
  }

  async remove(id: string) {
    const { count } = await this.prisma.db.blockedTime.deleteMany({
      where: { id },
    });
    if (count === 0) {
      throw new NotFoundError('Blocked time not found');
    }
    return { message: 'Blocked time removed' };
  }
}
