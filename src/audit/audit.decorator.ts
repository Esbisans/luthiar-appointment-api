import { SetMetadata } from '@nestjs/common';

export const AUDIT_META = 'audit:meta';

export interface AuditMeta {
  /** Dotted verb naming the business event, e.g. `appointment.cancelled`. */
  action: string;
  /** Resource type, e.g. `appointment`. */
  targetType: string;
  /**
   * How to derive the target id from the request and / or the response.
   * Default: `req.params.id` if present, else `res.id` (the created row).
   */
  targetIdFrom?: 'paramsId' | 'responseId';
}

/**
 * Mark a controller handler as auditable. The `AuditInterceptor` reads
 * this metadata and writes a row to `AuditEvent` AFTER the underlying
 * tx commits — so failed mutations leave no fake audit trail.
 *
 * Usage:
 *   @Post(':id/cancel')
 *   @Audit({ action: 'appointment.cancelled', targetType: 'appointment' })
 *   cancel(@Param('id') id: string) { ... }
 */
export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_META, meta);
