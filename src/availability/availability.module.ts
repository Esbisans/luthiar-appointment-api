import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller.js';
import { AvailabilityService } from './availability.service.js';
import { AvailabilityContextLoader } from './loaders/availability-context.loader.js';
import { AvailabilityCacheService } from './cache/availability-cache.service.js';

@Module({
  controllers: [AvailabilityController],
  providers: [
    AvailabilityService,
    AvailabilityContextLoader,
    AvailabilityCacheService,
  ],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
