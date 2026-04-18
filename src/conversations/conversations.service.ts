import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service.js';
import { BaseTenantService } from '../common/base-tenant.service.js';
import { NotFoundError, ValidationError } from '../common/errors/index.js';
import {
  AppendMessageDto,
  CloseConversationDto,
  ListConversationsQueryDto,
  StartConversationDto,
} from './dto/start-conversation.dto.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class ConversationsService extends BaseTenantService {
  constructor(prisma: PrismaService, cls: ClsService) {
    super(prisma, cls);
  }

  /**
   * Start a conversation. Idempotent by LiveKit room name: if a row
   * already exists for `livekitRoomName`, we return the existing one
   * rather than 409. Transient disconnects from LiveKit occasionally
   * re-enter the agent entrypoint; rejecting breaks the call.
   */
  async start(dto: StartConversationDto) {
    if (dto.livekitRoomName) {
      const existing = await this.prisma.db.conversation.findFirst({
        where: { livekitRoomName: dto.livekitRoomName },
      });
      if (existing) return existing;
    }
    return this.prisma.db.conversation.create({
      data: {
        channel: dto.channel,
        customerId: dto.customerId ?? null,
        livekitRoomName: dto.livekitRoomName ?? null,
        livekitSessionId: dto.livekitSessionId ?? null,
        externalCallId: dto.externalCallId ?? null,
        startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        metadata: (dto.metadata ?? null) as never,
      } as never,
    });
  }

  /**
   * Append one turn. Idempotent on `(conversationId, turnIndex)` — if the
   * same turn is POSTed twice (LiveKit retry, network flake), the second
   * call returns the first payload instead of 409.
   *
   * Accepts late arrivals after `endedAt` is set (STT finalisations
   * commonly straggle post-hangup). Those rows get
   * `metadata.lateArrival = true` but are persisted anyway.
   */
  async appendMessage(conversationId: string, dto: AppendMessageDto) {
    const conv = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
    });
    if (!conv) {
      throw new NotFoundError('Conversation not found', [
        { field: 'id', code: 'not_found', message: conversationId },
      ]);
    }

    const isLateArrival = !!conv.endedAt;
    const metadata = isLateArrival
      ? { ...((dto.metadata as Record<string, unknown>) ?? {}), lateArrival: true }
      : (dto.metadata ?? null);

    // SELECT-then-INSERT rather than INSERT-and-catch: a P2002 from
    // `create()` poisons the enclosing interactive tx (Postgres refuses
    // any further query until ROLLBACK), so the fallback SELECT that
    // would return the existing row can't run. Within a single request
    // we're the only writer for `(conversationId, turnIndex)`, so the
    // read is race-free.
    const existing = await this.prisma.db.message.findFirst({
      where: { conversationId, turnIndex: dto.turnIndex },
    });
    if (existing) {
      return { message: existing, duplicate: true };
    }

    const message = await this.prisma.db.message.create({
      data: {
        conversationId,
        role: dto.role,
        content: dto.content,
        turnIndex: dto.turnIndex,
        clientTimestamp: new Date(dto.clientTimestamp),
        toolCalls: (dto.toolCalls ?? null) as never,
        toolCallId: dto.toolCallId ?? null,
        audioUrl: dto.audioUrl ?? null,
        audioDurationMs: dto.audioDurationMs ?? null,
        interrupted: dto.interrupted ?? false,
        providerName: dto.providerName ?? null,
        requestModel: dto.requestModel ?? null,
        responseModel: dto.responseModel ?? null,
        inputTokens: dto.inputTokens ?? null,
        outputTokens: dto.outputTokens ?? null,
        cachedInputTokens: dto.cachedInputTokens ?? null,
        finishReason: dto.finishReason ?? null,
        ttftMs: dto.ttftMs ?? null,
        latencyMs: dto.latencyMs ?? null,
        costUsd: dto.costUsd ?? null,
        metadata: metadata as never,
      } as never,
    });

    await this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: { messageCount: { increment: 1 } } as never,
    });

    return {
      message,
      lateArrival: isLateArrival,
    };
  }

  /**
   * Close a conversation. Idempotent: a second `/close` with the same
   * payload returns 200 + the already-closed row. The first POST wins —
   * subsequent ones don't overwrite `endedReason` or rollups.
   */
  async close(conversationId: string, dto: CloseConversationDto) {
    const conv = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
    });
    if (!conv) {
      throw new NotFoundError('Conversation not found', [
        { field: 'id', code: 'not_found', message: conversationId },
      ]);
    }
    if (conv.endedAt) return conv; // idempotent no-op

    const endedAt = dto.endedAt ? new Date(dto.endedAt) : new Date();
    const durationMs = endedAt.getTime() - conv.startedAt.getTime();
    if (durationMs < 0) {
      throw new ValidationError('endedAt must be after startedAt', [
        { field: 'endedAt', code: 'before_start' },
      ]);
    }

    const u = dto.usage ?? {};
    return this.prisma.db.conversation.update({
      where: { id: conversationId },
      data: {
        endedAt,
        duration: durationMs,
        endedReason: dto.endedReason,
        summary: dto.summary ?? null,
        hasError: dto.endedReason === 'ERROR',
        errorReason: dto.errorReason ?? null,
        totalInputTokens: u.inputTokens ?? 0,
        totalOutputTokens: u.outputTokens ?? 0,
        totalCachedTokens: u.cachedInputTokens ?? 0,
        sttAudioSeconds: u.sttAudioSeconds ?? 0,
        ttsCharacters: u.ttsCharacters ?? 0,
        totalCostUsd: u.totalCostUsd ?? null,
        ...(dto.metadata
          ? {
              metadata: {
                ...((conv.metadata as Record<string, unknown>) ?? {}),
                ...dto.metadata,
              },
            }
          : {}),
      } as never,
    });
  }

  /** Cursor pagination — Stripe shape: `{data, has_more}`. */
  async findAll(query: ListConversationsQueryDto) {
    const limit = Math.min(
      query.limit ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const where: Record<string, unknown> = {};
    if (query.customerId) where['customerId'] = query.customerId;
    if (query.channel) where['channel'] = query.channel;
    if (query.endedReason) where['endedReason'] = query.endedReason;
    if (query.from || query.to) {
      const r: Record<string, Date> = {};
      if (query.from) r['gte'] = new Date(query.from);
      if (query.to) r['lt'] = new Date(query.to);
      where['startedAt'] = r;
    }

    const rows = await this.prisma.db.conversation.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit + 1,
      ...(query.startingAfter
        ? { cursor: { id: query.startingAfter }, skip: 1 }
        : {}),
    });
    const hasMore = rows.length > limit;
    return {
      data: hasMore ? rows.slice(0, limit) : rows,
      has_more: hasMore,
    };
  }

  async findOne(id: string) {
    const conv = await this.prisma.db.conversation.findFirst({
      where: { id },
      include: {
        messages: {
          orderBy: [{ turnIndex: 'asc' }, { clientTimestamp: 'asc' }],
        },
      },
    });
    if (!conv) {
      throw new NotFoundError('Conversation not found', [
        { field: 'id', code: 'not_found', message: id },
      ]);
    }
    return conv;
  }
}
