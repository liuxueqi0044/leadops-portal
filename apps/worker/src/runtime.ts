import type { Logger } from 'pino';
import type { DatabaseHandle } from '@leadops/db/client';
import { healthCheck } from '@leadops/db/client';
import { recordDbHealth, recordWorkerHeartbeat } from '@leadops/observability';

export interface WorkerRuntimeTimers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export function defaultTimers(): WorkerRuntimeTimers {
  return {
    setInterval: (cb: () => void, ms: number) => globalThis.setInterval(cb, ms),
    clearInterval: (id: unknown) => {
      if (id != null) globalThis.clearInterval(id as NodeJS.Timeout);
    },
    setTimeout: (cb: () => void, ms: number) => globalThis.setTimeout(cb, ms),
    clearTimeout: (id: unknown) => {
      if (id != null) globalThis.clearTimeout(id as NodeJS.Timeout);
    },
  };
}

export interface WorkerRuntimeOptions {
  logger: Logger;
  database: DatabaseHandle;
  heartbeatMs: number;
  shutdownTimeoutMs: number;
  timers?: WorkerRuntimeTimers;
  exit?: (code: number) => void;
}

export interface WorkerRuntime {
  start(): Promise<void>;
  shutdown(signal: string): Promise<void>;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  let startPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let shuttingDown = false;
  let heartbeatTimer: unknown = null;
  let probeInFlight: Promise<void> | null = null;

  const timers = options.timers ?? defaultTimers();
  const exit = options.exit ?? process.exit.bind(process);

  const runProbe = (event: 'worker.startup' | 'worker.heartbeat'): Promise<void> => {
    if (probeInFlight) return probeInFlight;

    const probe = (async (): Promise<void> => {
      try {
        const ok = await healthCheck(options.database.db);
        recordDbHealth(ok ? 'healthy' : 'unhealthy');
        recordWorkerHeartbeat(ok ? 'alive' : 'lost');
        options.logger.info(
          { event, database: ok ? 'connected' : 'disconnected' },
          event === 'worker.heartbeat' ? 'Worker heartbeat' : 'Worker database probe',
        );
      } catch {
        recordDbHealth('unhealthy');
        recordWorkerHeartbeat('lost');
        options.logger.warn(
          { event, database: 'unavailable' },
          event === 'worker.heartbeat'
            ? 'Worker heartbeat failed'
            : 'Worker database probe failed',
        );
      }
    })();

    probeInFlight = probe;
    void probe.finally(() => {
      if (probeInFlight === probe) probeInFlight = null;
    });
    return probe;
  };

  const start = async (): Promise<void> => {
    options.logger.info({ event: 'worker.startup' }, 'Worker starting');
    await runProbe('worker.startup');
    if (shuttingDown) return;

    heartbeatTimer = timers.setInterval(() => {
      if (shuttingDown || probeInFlight) return;
      void runProbe('worker.heartbeat');
    }, options.heartbeatMs);
  };

  const shutdown = async (signal: string): Promise<void> => {
    shuttingDown = true;
    options.logger.info({ event: 'worker.shutdown', signal }, 'Worker shutting down');

    if (heartbeatTimer !== null) {
      timers.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    interface ShutdownOutcome {
      code: number;
      timedOut: boolean;
    }
    let resolveTimeout!: (outcome: ShutdownOutcome) => void;
    const timeout = new Promise<ShutdownOutcome>((resolve) => {
      resolveTimeout = resolve;
    });
    const timeoutTimer = timers.setTimeout(() => {
      options.logger.error(
        { event: 'worker.force_exit', timeoutMs: options.shutdownTimeoutMs },
        'Forced exit',
      );
      resolveTimeout({ code: 1, timedOut: true });
    }, options.shutdownTimeoutMs);

    const graceful = (async (): Promise<ShutdownOutcome> => {
      try {
        if (startPromise) await startPromise;
        if (probeInFlight) await probeInFlight;
        await options.database.close();
        return { code: 0, timedOut: false };
      } catch {
        options.logger.error(
          { event: 'worker.close_failed' },
          'Worker failed to close cleanly',
        );
        return { code: 1, timedOut: false };
      }
    })();

    const outcome = await Promise.race([graceful, timeout]);
    if (!outcome.timedOut) {
      timers.clearTimeout(timeoutTimer);
      if (outcome.code === 0) {
        options.logger.info({ event: 'worker.closed' }, 'Worker closed cleanly');
      }
    }
    exit(outcome.code);
  };

  return {
    start(): Promise<void> {
      startPromise ??= start();
      return startPromise;
    },

    shutdown(signal: string): Promise<void> {
      shutdownPromise ??= shutdown(signal);
      return shutdownPromise;
    },
  };
}
