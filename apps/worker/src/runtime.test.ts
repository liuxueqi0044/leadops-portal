import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRuntime, type WorkerRuntimeTimers } from './runtime.js';
import type { DatabaseHandle, DbClient } from '@leadops/db/client';
import type { Logger } from 'pino';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: 'info',
    child: vi.fn(() => createMockLogger()),
    silent: vi.fn(),
  } as unknown as Logger;
}

function createMockDatabase(options: {
  execute?: () => Promise<unknown>;
  close?: () => Promise<void>;
} = {}): DatabaseHandle {
  return {
    db: {
      execute: vi.fn(options.execute ?? (() => Promise.resolve(undefined))),
    } as unknown as DbClient,
    sql: {
      unsafe: vi.fn(),
    } as unknown as DatabaseHandle['sql'],
    close: vi.fn(options.close ?? (() => Promise.resolve())),
  };
}

function createTimerHarness(): {
  timers: WorkerRuntimeTimers;
  intervalCallbacks: (() => void)[];
  timeoutCallbacks: (() => void)[];
} {
  const intervalCallbacks: (() => void)[] = [];
  const timeoutCallbacks: (() => void)[] = [];
  return {
    intervalCallbacks,
    timeoutCallbacks,
    timers: {
      setInterval: vi.fn((callback: () => void) => {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length;
      }),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        timeoutCallbacks.push(callback);
        return timeoutCallbacks.length;
      }),
      clearTimeout: vi.fn(),
    },
  };
}

describe('createWorkerRuntime', () => {
  let logger: Logger;
  let database: DatabaseHandle;
  let exit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = createMockLogger();
    database = createMockDatabase();
    exit = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createRuntime(
    overrides: Partial<Parameters<typeof createWorkerRuntime>[0]> = {},
  ) {
    const harness = createTimerHarness();
    const runtime = createWorkerRuntime({
      logger,
      database,
      heartbeatMs: 1_000,
      shutdownTimeoutMs: 5_000,
      timers: harness.timers,
      exit,
      ...overrides,
    });
    return { runtime, ...harness };
  }

  it('starts only once and installs one heartbeat timer', async () => {
    const { runtime, timers } = createRuntime();

    await Promise.all([runtime.start(), runtime.start()]);

    expect(timers.setInterval).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { event: 'worker.startup' },
      'Worker starting',
    );
  });

  it('does not overlap heartbeat probes', async () => {
    const heartbeat = createDeferred<unknown>();
    const execute = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => heartbeat.promise);
    database = createMockDatabase({ execute });
    const { runtime, intervalCallbacks } = createRuntime({ database });
    await runtime.start();

    intervalCallbacks[0]?.();
    intervalCallbacks[0]?.();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(2);
    heartbeat.resolve(undefined);
    await heartbeat.promise;
  });

  it('waits for an in-flight heartbeat before closing the database', async () => {
    const heartbeat = createDeferred<unknown>();
    const close = vi.fn(() => Promise.resolve());
    const execute = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => heartbeat.promise);
    database = createMockDatabase({ execute, close });
    const { runtime, intervalCallbacks } = createRuntime({ database });
    await runtime.start();
    intervalCallbacks[0]?.();
    await Promise.resolve();

    const shutdown = runtime.shutdown('SIGTERM');
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    heartbeat.resolve(undefined);
    await shutdown;
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('clears the heartbeat timer during shutdown', async () => {
    const { runtime, timers } = createRuntime();
    await runtime.start();

    await runtime.shutdown('SIGTERM');

    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
  });

  it('runs shutdown only once and returns the same completion', async () => {
    const close = vi.fn(() => Promise.resolve());
    database = createMockDatabase({ close });
    const { runtime } = createRuntime({ database });
    await runtime.start();

    await Promise.all([
      runtime.shutdown('SIGTERM'),
      runtime.shutdown('SIGINT'),
    ]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 when database close fails', async () => {
    database = createMockDatabase({
      close: () => Promise.reject(new Error('connection string secret')),
    });
    const { runtime } = createRuntime({ database });
    await runtime.start();

    await runtime.shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { event: 'worker.close_failed' },
      'Worker failed to close cleanly',
    );
  });

  it('exits exactly once with code 1 when graceful shutdown times out', async () => {
    const pendingClose = createDeferred<undefined>();
    database = createMockDatabase({ close: () => pendingClose.promise });
    const { runtime, timeoutCallbacks } = createRuntime({
      database,
      shutdownTimeoutMs: 500,
    });
    await runtime.start();

    const shutdown = runtime.shutdown('SIGTERM');
    await Promise.resolve();
    timeoutCallbacks[0]?.();
    await shutdown;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    pendingClose.resolve(undefined);
  });

  it('does not run a heartbeat after shutdown begins', async () => {
    const execute = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    database = createMockDatabase({ execute });
    const { runtime, intervalCallbacks } = createRuntime({ database });
    await runtime.start();
    await runtime.shutdown('SIGTERM');

    intervalCallbacks[0]?.();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
