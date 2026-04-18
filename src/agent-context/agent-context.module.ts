import { Module } from '@nestjs/common';
import { AgentContextController } from './agent-context.controller.js';
import { AgentContextService } from './agent-context.service.js';

@Module({
  controllers: [AgentContextController],
  providers: [AgentContextService],
})
export class AgentContextModule {}
