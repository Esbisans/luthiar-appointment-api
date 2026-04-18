import { Controller, Get, Headers, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AgentContextService } from './agent-context.service.js';

/**
 * Single-shot "who am I acting on behalf of?" bundle. The voice agent
 * calls this ONCE in its entrypoint (before `ctx.connect()`) so the
 * first greeting has the right business name, timezone, services,
 * and policy baked into its system prompt.
 *
 * Auth: any authenticated principal (API key or JWT OWNER) can read
 * its own context. The response is private-cacheable (`Cache-Control:
 * private, max-age=60`) with a content-hash ETag that mutates when any
 * of the composed rows changes.
 */
@ApiTags('agent-context')
@ApiBearerAuth()
@Controller('agent/context')
export class AgentContextController {
  constructor(private readonly svc: AgentContextService) {}

  @Get()
  @ApiOperation({
    summary: 'Agent context bundle',
    description:
      'One fetch returns business profile + hours + services + staff + capabilities. Supports `If-None-Match` → 304. Cache-Control is 60s (private) so multiple concurrent calls on the same pod dedupe trivially without an upstream cache layer.',
  })
  async get(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { bundle, etag } = await this.svc.buildContext();

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');
    res.setHeader('Vary', 'Authorization, x-api-key');

    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304);
      return;
    }

    return bundle;
  }
}
