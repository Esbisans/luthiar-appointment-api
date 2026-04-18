import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { OutboxModule } from './events/outbox.module.js';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor.js';
import { CustomersModule } from '../customers/customers.module.js';

@Module({
  imports: [OutboxModule, CustomersModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, IdempotencyInterceptor],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
