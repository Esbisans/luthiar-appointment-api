import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ChannelType } from '../../generated/prisma/enums.js';

const NAME_LIKE = /^[A-Za-z0-9_\-:.]{1,120}$/;

export class StartConversationDto {
  @ApiProperty({ enum: ChannelType, example: 'VOICE' })
  @IsEnum(ChannelType)
  channel!: ChannelType;

  @ApiProperty({ required: false, description: 'Customer already matched by phone.' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({
    required: false,
    description: 'LiveKit room name for correlation (unique — a second start for the same room replays the first).',
    example: 'lk-room-abc-123',
  })
  @IsOptional()
  @IsString()
  @Matches(NAME_LIKE)
  livekitRoomName?: string;

  @ApiProperty({ required: false, example: 'RE4d2e...session' })
  @IsOptional()
  @IsString()
  @Matches(NAME_LIKE)
  livekitSessionId?: string;

  @ApiProperty({
    required: false,
    description: 'Provider-agnostic external identifier (Twilio CallSid, Vapi callId, etc).',
    example: 'CA9a0b2...',
  })
  @IsOptional()
  @IsString()
  @Matches(NAME_LIKE)
  externalCallId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class AppendMessageDto {
  @ApiProperty({ description: 'Monotonic turn index within the conversation (0-based, may have gaps).' })
  @IsInt()
  @Min(0)
  turnIndex!: number;

  @ApiProperty({ description: 'When the agent observed the event — ISO-8601 with offset.' })
  @IsISO8601()
  clientTimestamp!: string;

  @ApiProperty({ enum: ['USER', 'ASSISTANT', 'SYSTEM', 'TOOL'] })
  @IsEnum(['USER', 'ASSISTANT', 'SYSTEM', 'TOOL'])
  role!: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';

  @ApiProperty()
  @IsString()
  @MaxLength(50_000)
  content!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;

  @ApiProperty({ required: false, description: 'For TOOL-role messages, the assistant tool_call.id this responds to.' })
  @IsOptional()
  @IsString()
  toolCallId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  audioUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  audioDurationMs?: number;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  interrupted?: boolean;

  // OpenTelemetry GenAI alignment — all optional.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  providerName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  requestModel?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  responseModel?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  inputTokens?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  outputTokens?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  cachedInputTokens?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  finishReason?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  ttftMs?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  latencyMs?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  costUsd?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CloseConversationDto {
  @ApiProperty({
    enum: [
      'COMPLETED',
      'USER_HANGUP',
      'AGENT_HANGUP',
      'PARTICIPANT_DISCONNECTED',
      'ERROR',
      'TIMEOUT',
      'TRANSFERRED',
    ],
  })
  @IsEnum([
    'COMPLETED',
    'USER_HANGUP',
    'AGENT_HANGUP',
    'PARTICIPANT_DISCONNECTED',
    'ERROR',
    'TIMEOUT',
    'TRANSFERRED',
  ])
  endedReason!:
    | 'COMPLETED'
    | 'USER_HANGUP'
    | 'AGENT_HANGUP'
    | 'PARTICIPANT_DISCONNECTED'
    | 'ERROR'
    | 'TIMEOUT'
    | 'TRANSFERRED';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsISO8601()
  endedAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  summary?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  errorReason?: string;

  @ApiProperty({
    required: false,
    description:
      'Per-conversation usage rollup. Merged into the conversation row.',
  })
  @IsOptional()
  @IsObject()
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    sttAudioSeconds?: number;
    ttsCharacters?: number;
    totalCostUsd?: number;
  };

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListConversationsQueryDto {
  @ApiProperty({ required: false, description: 'Cursor: conversation id AFTER which to start.' })
  @IsOptional()
  @IsUUID()
  startingAfter?: string;

  @ApiProperty({ required: false, default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ required: false, enum: ChannelType })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEnum([
    'COMPLETED',
    'USER_HANGUP',
    'AGENT_HANGUP',
    'PARTICIPANT_DISCONNECTED',
    'ERROR',
    'TIMEOUT',
    'TRANSFERRED',
  ])
  endedReason?: string;

  @ApiProperty({ required: false, description: 'ISO-8601 start (inclusive).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiProperty({ required: false, description: 'ISO-8601 end (exclusive).' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
