import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service.js';
import { SearchQueryDto } from './dto/search-query.dto.js';

/**
 * Top-bar global search — mixed-entity results grouped by type.
 *
 * Not a spotlight / command palette. The UI is a VISIBLE search input
 * (Booksy / Fresha / Shopify Admin style, not Linear / Notion Cmd+K).
 * Actions / navigation commands stay on the client — no round-trip for
 * static labels.
 *
 * Expected frontend pattern: `useQuery(['search', q])` with a 250ms
 * debounce + AbortController to cancel in-flight on keystroke. Backend
 * does not rate-limit aggressively; user searches often.
 */
@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search customers, appointments, conversations, staff, services.',
    description:
      'Mixed-entity search. Results grouped by type, sorted by per-type relevance (pg_trgm similarity for short fields, ts_rank_cd for long). Empty `q` or `q.length < 2` returns empty groups (no 400). Accent-insensitive via `unaccent`.',
  })
  async search(@Query() query: SearchQueryDto) {
    return this.svc.search(query.q ?? '', query.types, query.limit ?? 5);
  }
}
