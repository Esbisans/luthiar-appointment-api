import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';
import { BlockedTimesController } from './blocked-times.controller.js';
import { BlockedTimesService } from './blocked-times.service.js';

@Module({
  controllers: [StaffController, BlockedTimesController],
  providers: [StaffService, BlockedTimesService],
  exports: [StaffService, BlockedTimesService],
})
export class StaffModule {}
