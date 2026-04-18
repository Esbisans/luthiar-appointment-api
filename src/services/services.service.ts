import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import { NotFoundError } from '../common/errors/index.js';
import { CreateServiceDto } from './dto/create-service.dto.js';
import { UpdateServiceDto } from './dto/update-service.dto.js';
import { PaginationDto } from '../common/dto/pagination.dto.js';

@Injectable()
export class ServicesService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  async create(dto: CreateServiceDto) {
    return this.prisma.db.service.create({
      data: dto as never,
    });
  }

  async findAll(pagination: PaginationDto) {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.db.service.findMany({
        where: { deletedAt: null },
        skip,
        take: limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.db.service.count({
        where: { deletedAt: null },
      }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const service = await this.prisma.db.service.findFirst({
      where: { id, deletedAt: null },
    });

    if (!service) {
      throw new NotFoundError('Service not found', [
        { field: 'id', code: 'not_found', message: `No service with id ${id}` },
      ]);
    }

    return service;
  }

  async update(id: string, dto: UpdateServiceDto) {
    await this.findOne(id);

    return this.prisma.db.service.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.db.service.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Service deleted' };
  }
}
