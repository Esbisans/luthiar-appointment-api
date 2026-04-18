import 'reflect-metadata';
import type { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';

// The prisma indicator transitively imports the generated Prisma client,
// whose compiled output uses `import.meta.url` — unparseable by ts-jest in
// CJS mode. Stub the indicator modules before the controller loads them.
jest.mock('./indicators/prisma.health.js', () => ({ PrismaHealthIndicator: class {} }), {
  virtual: true,
});
jest.mock('./indicators/redis.health.js', () => ({ RedisHealthIndicator: class {} }), {
  virtual: true,
});
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }), {
  virtual: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HealthController } = require('./health.controller.js');
type HealthControllerType = InstanceType<typeof HealthController>;

/**
 * Unit-scoped: we don't care about Nest DI or Terminus internals here,
 * just that (a) the class carries the SkipThrottle metadata for both
 * named throttlers and (b) /health/ready caches the Terminus result for
 * ~5s so public callers cannot amplify into the database.
 */
describe('HealthController', () => {
  const okResult: HealthCheckResult = {
    status: 'ok',
    info: {
      database: { status: 'up' },
      redis: { status: 'up' },
    },
    error: {},
    details: {
      database: { status: 'up' },
      redis: { status: 'up' },
    },
  };

  function build(): { ctrl: HealthControllerType; check: jest.Mock } {
    const check = jest.fn(async () => okResult);
    const health = { check } as unknown as HealthCheckService;
    const ctrl = new HealthController(health, {}, {});
    return { ctrl, check };
  }

  describe('SkipThrottle metadata', () => {
    it('class carries SkipThrottle for both named throttlers', () => {
      // `SkipThrottle({ name: true })` stores one metadata key per named
      // throttler as `THROTTLER:SKIP<name>` (see node_modules/@nestjs/
      // throttler/dist/throttler.decorator.js), not a single object map.
      expect(Reflect.getMetadata('THROTTLER:SKIPglobal-ip', HealthController)).toBe(true);
      expect(Reflect.getMetadata('THROTTLER:SKIPtenant', HealthController)).toBe(true);
    });
  });

  describe('/health/live', () => {
    it('delegates to HealthCheckService with no indicators', async () => {
      const { ctrl, check } = build();
      await ctrl.live();
      expect(check).toHaveBeenCalledTimes(1);
      expect(check).toHaveBeenCalledWith([]);
    });
  });

  describe('/health/ready caching', () => {
    it('hits the indicators once, returns cached on second call inside TTL', async () => {
      const { ctrl, check } = build();
      await ctrl.ready();
      await ctrl.ready();
      expect(check).toHaveBeenCalledTimes(1);
    });

    it('re-runs the check after the cache TTL elapses', async () => {
      jest.useFakeTimers({ now: Date.now() });
      try {
        const { ctrl, check } = build();
        await ctrl.ready();
        expect(check).toHaveBeenCalledTimes(1);
        // Still inside window — cached.
        jest.setSystemTime(Date.now() + 4_999);
        await ctrl.ready();
        expect(check).toHaveBeenCalledTimes(1);
        // Past the 5s window — re-check.
        jest.setSystemTime(Date.now() + 2);
        await ctrl.ready();
        expect(check).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns the same shape whether cached or fresh', async () => {
      const { ctrl } = build();
      const first = await ctrl.ready();
      const second = await ctrl.ready();
      expect(second).toEqual(first);
    });
  });
});
