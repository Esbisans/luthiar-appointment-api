import { Injectable, NestMiddleware } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Request, Response, NextFunction } from 'express';
import { ulid } from 'ulid';

export const TRACE_ID_HEADER = 'x-request-id';
export const TRACEPARENT_HEADER = 'traceparent';
export const VOICE_CALL_ID_HEADER = 'x-voice-call-id';
export const SESSION_ID_HEADER = 'x-session-id';

export const CLS_TRACE_ID_KEY = 'traceId';
export const CLS_TRACEPARENT_KEY = 'traceparent';
export const CLS_VOICE_CALL_ID_KEY = 'voiceCallId';
export const CLS_SESSION_ID_KEY = 'sessionId';

const VALID_HEADER = /^[A-Za-z0-9._:\-]{1,200}$/;

declare module 'express' {
  interface Request {
    id?: string;
  }
}

/**
 * Per-request correlation identifiers. Three layers:
 *
 *   1. `traceId` (ULID, 26 chars) — internal, time-ordered, human-grep-friendly.
 *      Populated from `X-Request-Id` if a trusted proxy supplied one,
 *      else minted. Always set, always logged.
 *
 *   2. `traceparent` (W3C Trace Context) — `00-<trace_id_32hex>-<span_id_16hex>-<flags_2hex>`.
 *      OPTIONAL. If the caller supplies it, we propagate it so when
 *      OpenTelemetry lands later (Fase 11) every existing client already
 *      sends the right header — zero retrofit. We do NOT generate one
 *      synthetically here (that's the OTel SDK's job).
 *
 *   3. Domain correlation — `X-Voice-Call-Id` (LiveKit room/job id),
 *      `X-Session-Id` (multi-turn agent session). Stamped by the agent so
 *      a backend log line can be pivoted from a single voice call.
 *
 * All four IDs land in CLS for Pino to serialize on every log line, and
 * the request `traceId` echoes back as the `X-Request-Id` response header.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const id = pickHeader(req, TRACE_ID_HEADER) ?? ulid();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    this.cls.set(CLS_TRACE_ID_KEY, id);

    const traceparent = pickHeader(req, TRACEPARENT_HEADER);
    if (traceparent && isValidTraceparent(traceparent)) {
      this.cls.set(CLS_TRACEPARENT_KEY, traceparent);
      // Echo back so the client can chain its next request's parent-id.
      res.setHeader('traceparent', traceparent);
    }

    const voiceCallId = pickHeader(req, VOICE_CALL_ID_HEADER);
    if (voiceCallId) this.cls.set(CLS_VOICE_CALL_ID_KEY, voiceCallId);

    const sessionId = pickHeader(req, SESSION_ID_HEADER);
    if (sessionId) this.cls.set(CLS_SESSION_ID_KEY, sessionId);

    next();
  }
}

function pickHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') return undefined;
  // Reject obviously malicious values — we'll log this header verbatim,
  // so log injection / huge strings stop here.
  return VALID_HEADER.test(value) ? value : undefined;
}

/**
 * W3C Trace Context v00 format check. Format is strict so OTel back-ends
 * accept the pass-through; reject anything else silently.
 *
 *   `00-<trace_id_32hex>-<parent_id_16hex>-<flags_2hex>`
 */
function isValidTraceparent(v: string): boolean {
  return /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(v);
}
