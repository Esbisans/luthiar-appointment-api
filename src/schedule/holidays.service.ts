import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import {
  NotFoundError,
  UniqueViolationError,
} from '../common/errors/index.js';
import { CreateHolidayDto } from './dto/create-holiday.dto.js';
import { UpdateHolidayDto } from './dto/update-holiday.dto.js';
import { BulkHolidaysDto } from './dto/bulk-holidays.dto.js';
import { ListHolidaysQueryDto } from './dto/list-holidays-query.dto.js';
import { ImportHolidaysQueryDto } from './dto/import-holidays-query.dto.js';
import { toHolidayDate } from './utils/luxon.util.js';

@Injectable()
export class HolidaysService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  async findAll(query: ListHolidaysQueryDto) {
    const where: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];
    if (query.year !== undefined) {
      const start = new Date(Date.UTC(query.year, 0, 1));
      const end = new Date(Date.UTC(query.year + 1, 0, 1));
      and.push({ date: { gte: start } }, { date: { lt: end } });
    }
    if (query.from) and.push({ date: { gte: toHolidayDate(query.from) } });
    if (query.to) and.push({ date: { lt: toHolidayDate(query.to) } });
    if (and.length > 0) where['AND'] = and;

    return this.prisma.db.holiday.findMany({
      where,
      orderBy: { date: 'asc' },
    });
  }

  async create(dto: CreateHolidayDto) {
    try {
      return await this.prisma.db.holiday.create({
        data: {
          date: toHolidayDate(dto.date),
          name: dto.name,
          isRecurring: dto.isRecurring ?? false,
        } as never,
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new UniqueViolationError(
          'A holiday already exists on this date',
          [{ field: 'date', code: 'taken', message: dto.date }],
        );
      }
      throw e;
    }
  }

  async bulkCreate(dto: BulkHolidaysDto) {
    // Validate dates first so a bad row doesn't partially persist.
    const rows = dto.items.map((it) => ({
      date: toHolidayDate(it.date),
      name: it.name,
      isRecurring: it.isRecurring ?? false,
    }));
    const { count } = await this.prisma.db.holiday.createMany({
      data: rows as never,
      skipDuplicates: true,
    });
    return { created: count, skipped: rows.length - count };
  }

  async update(id: string, dto: UpdateHolidayDto) {
    const existing = await this.prisma.db.holiday.findFirst({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Holiday not found');
    }
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.isRecurring !== undefined) patch['isRecurring'] = dto.isRecurring;
    if (dto.date !== undefined) patch['date'] = toHolidayDate(dto.date);
    try {
      return await this.prisma.db.holiday.update({
        where: { id },
        data: patch as never,
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new UniqueViolationError(
          'A holiday already exists on this date',
          [{ field: 'date', code: 'taken' }],
        );
      }
      throw e;
    }
  }

  async remove(id: string) {
    const { count } = await this.prisma.db.holiday.deleteMany({
      where: { id },
    });
    if (count === 0) throw new NotFoundError('Holiday not found');
    return { message: 'Holiday removed' };
  }

  /**
   * STUB — official-holiday import from date.nager.at.
   *
   * Kept in the public API so clients can discover the capability via
   * Swagger and so we can ship a migration path without breaking the URL
   * contract later.
   *
   * Full spec and re-implementation plan: see `docs/deferred-work.md`
   * entry D20. Short version: we return 501 with a machine-readable
   * payload describing the intended behaviour.
   */
  async importOfficial(query: ImportHolidaysQueryDto) {
    return {
      status: 'not_yet_implemented',
      message:
        'Official holiday import is stubbed. See docs/deferred-work.md D20 for the full spec and rollout plan.',
      requested: {
        country: query.country.toUpperCase(),
        year: query.year,
      },
      plannedEndpointBehavior: {
        upstream:
          'https://date.nager.at/api/v3/PublicHolidays/{year}/{country}',
        onSuccess:
          'Maps each upstream entry to a Holiday row (date, name, isRecurring=false) and calls bulkCreate with skipDuplicates=true.',
        idempotency:
          'Safe to call repeatedly for the same country/year — duplicates are skipped by the unique (businessId, date) constraint.',
      },
    };
  }
}
