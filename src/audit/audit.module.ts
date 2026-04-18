import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';

/**
 * `@Global` so the `@Audit()` decorator + `AuditInterceptor` can be
 * applied per-controller across the codebase without each module
 * re-importing AuditModule. Mirrors OutboxModule's @Global pattern.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditInterceptor],
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}
