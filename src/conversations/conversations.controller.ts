import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IdempotencyInterceptor } from '../appointments/interceptors/idempotency.interceptor.js';
import { ConversationsService } from './conversations.service.js';
import {
  AppendMessageDto,
  CloseConversationDto,
  ListConversationsQueryDto,
  StartConversationDto,
} from './dto/start-conversation.dto.js';

/**
 * Conversation persistence for voice / WhatsApp / web-chat agents.
 *
 * Expected call pattern from a LiveKit agent:
 *   POST /conversations               → returns {id}
 *   POST /conversations/:id/messages  → one POST per turn, with
 *                                        Idempotency-Key = ChatMessage.id
 *   POST /conversations/:id/close     → with usage rollup
 *
 * All endpoints are API-key friendly (role AGENT) because the voice
 * agent is the primary caller. Dashboard (JWT) uses GET for history.
 */
@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly svc: ConversationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a conversation',
    description:
      'Idempotent on `livekitRoomName` — a second start for the same room returns the existing conversation instead of creating a duplicate.',
  })
  start(@Body() dto: StartConversationDto) {
    return this.svc.start(dto);
  }

  @Post(':id/messages')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Append one turn',
    description:
      'Callers SHOULD send `Idempotency-Key: <chat_message_id>` for safe retries. `(conversationId, turnIndex)` is additionally unique as a safety net. Late arrivals after close are accepted and flagged with `metadata.lateArrival = true`.',
  })
  @HttpCode(201)
  async appendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AppendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.svc.appendMessage(id, dto);
    // A late arrival (POSTed after close) returns 202 per RFC 7231:
    // "the request has been accepted for processing, but the processing
    // has not been completed." Clients should not retry on 202.
    if (result.lateArrival) res.status(202);
    return result;
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close with usage rollup',
    description:
      'Idempotent — a second close on an already-closed conversation returns the existing row unchanged.',
  })
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseConversationDto,
  ) {
    return this.svc.close(id, dto);
  }

  @Get()
  findAll(@Query() query: ListConversationsQueryDto) {
    return this.svc.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a conversation with its full message history.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }
}
