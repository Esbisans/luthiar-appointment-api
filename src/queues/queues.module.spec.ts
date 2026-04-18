import { QueuesModule } from './queues.module.js';

/**
 * The shutdown handler reaches into each processor's `worker` property (which
 * `WorkerHost` from `@nestjs/bullmq` exposes) and races `worker.close(false)`
 * against a timeout. We mock the worker surface and the processor objects so
 * the test stays unit-scoped — no Redis, no real BullMQ.
 */
type MockWorker = { close: jest.Mock };
type MockProcessor = { worker?: MockWorker };

function makeProcessor(gracefulImpl?: () => Promise<void>): MockProcessor {
  return {
    worker: {
      close: jest.fn(async (force?: boolean) => {
        // force close is always synchronous-fast in tests so the fallback
        // branch can resolve cleanly.
        if (force) return undefined;
        return (gracefulImpl ?? (async () => undefined))();
      }),
    },
  };
}

function buildModule(processors: MockProcessor[]) {
  const [n, p, d, o] = processors;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
  // Constructor reads producer + 4 processors + logger; we never invoke
  // onModuleInit so producer can be a stub.
  return new QueuesModule(
    {} as never,
    n as never,
    p as never,
    d as never,
    o as never,
    logger,
  );
}

describe('QueuesModule.onApplicationShutdown', () => {
  it('calls worker.close(false) on every registered processor', async () => {
    const processors = [
      makeProcessor(),
      makeProcessor(),
      makeProcessor(),
      makeProcessor(),
    ];
    const mod = buildModule(processors);

    await mod.onApplicationShutdown('SIGTERM');

    for (const p of processors) {
      expect(p.worker!.close).toHaveBeenCalledTimes(1);
      expect(p.worker!.close).toHaveBeenCalledWith(false);
    }
  });

  it('falls back to force close when graceful drain exceeds timeout', async () => {
    jest.useFakeTimers();
    try {
      // Two processors hang forever on graceful close; timeout should
      // fire and we should see a second close(true) call on each.
      const hang = () => new Promise<void>(() => undefined);
      const processors = [
        makeProcessor(hang),
        makeProcessor(hang),
        makeProcessor(hang),
        makeProcessor(hang),
      ];
      const mod = buildModule(processors);

      const shutdown = mod.onApplicationShutdown('SIGTERM');
      // Advance past the 25s drain budget.
      await jest.advanceTimersByTimeAsync(26_000);
      await shutdown;

      for (const p of processors) {
        expect(p.worker!.close).toHaveBeenCalledWith(false);
        expect(p.worker!.close).toHaveBeenCalledWith(true);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('is a no-op when no processor exposes a worker', async () => {
    const processors: MockProcessor[] = [{}, {}, {}, {}];
    const mod = buildModule(processors);
    await expect(mod.onApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
  });
});
