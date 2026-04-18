/**
 * Payload for `events:sync` — client resume after long disconnect.
 * Validated manually inside the gateway handler (class-validator pipes
 * don't auto-apply to Socket.io messages in the standard flow).
 */
export interface SyncRequestDto {
  /** ULID or ISO timestamp of the last event the client saw. */
  since: string;
  /** Max events to replay (hard cap at 500). Default 100. */
  limit?: number;
}

export function parseSyncRequest(raw: unknown): SyncRequestDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['since'] !== 'string' || obj['since'].length === 0) return null;
  const since = obj['since'];
  const limit =
    typeof obj['limit'] === 'number'
      ? Math.min(500, Math.max(1, Math.floor(obj['limit'])))
      : 100;
  return { since, limit };
}
