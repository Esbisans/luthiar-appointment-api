import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export abstract class BaseTenantService {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly cls: ClsService,
  ) {}

  protected get businessId(): string {
    return this.cls.get('businessId');
  }
}
