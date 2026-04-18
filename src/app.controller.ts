import { Controller } from '@nestjs/common';

/**
 * Root controller is intentionally empty. Health endpoints live in
 * `src/health/health.controller.ts` (`/health/live` + `/health/ready`).
 */
@Controller()
export class AppController {}
