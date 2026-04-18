import { Module } from '@nestjs/common';
import { BusinessHoursController } from './business-hours.controller.js';
import { BusinessHoursService } from './business-hours.service.js';
import { HolidaysController } from './holidays.controller.js';
import { HolidaysService } from './holidays.service.js';

@Module({
  controllers: [BusinessHoursController, HolidaysController],
  providers: [BusinessHoursService, HolidaysService],
  exports: [BusinessHoursService, HolidaysService],
})
export class ScheduleModule {}
