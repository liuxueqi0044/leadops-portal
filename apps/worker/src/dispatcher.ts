import type { Logger } from "pino";
import type postgres from "postgres";
import type { WorkerRuntimeTimers } from "./runtime.js";
import {
  claimOutboxItems,
  markOutboxDelivered,
  markOutboxFailed,
} from "@leadops/db";

export interface OutboxDispatcherOptions {
  logger: Logger;
  database: postgres.Sql;
  pollIntervalMs: number;
  batchSize: number;
  concurrency: number;
  workerId: string;
  timers: WorkerRuntimeTimers;
  enqueueJob: (item: { id: string; messageType: string; payload: Record<string, unknown>; organizationId: string }) => Promise<void>;
}

export function createOutboxDispatcher(options: OutboxDispatcherOptions) {
  let timer: unknown = null;
  let running = false;
  let shuttingDown = false;
  let inFlight: Promise<void> | null = null;

  const poll = async (): Promise<void> => {
    if (inFlight) return;
    if (shuttingDown) return;

    const job = (async () => {
      try {
        const items = await claimOutboxItems(options.database, options.workerId, options.batchSize);

        if (items.length > 0) {
          options.logger.info(
            { event: "outbox.claimed", count: items.length },
            `Claimed ${String(items.length)} outbox items`,
          );

          const deliver = async (item: (typeof items)[number]): Promise<void> => {
            if (shuttingDown) return;
            try {
              // Enqueue to pg-boss via the injected callback
              await options.enqueueJob({
                id: item.id,
                messageType: item.messageType,
                payload: item.payload,
                organizationId: item.organizationId,
              });
              options.logger.debug(
                { event: "outbox.enqueued", outboxId: item.id },
                "Enqueued outbox item",
              );

              // Mark outbox as delivered (with lockedBy check)
              const delivered = await markOutboxDelivered(
                options.database,
                item.id,
                options.workerId,
              );
              if (!delivered) {
                options.logger.warn(
                  { outboxId: item.id },
                  "Failed to mark outbox delivered (lockedBy mismatch or already delivered)",
                );
              } else {
                options.logger.debug(
                  { event: "outbox.delivered", outboxId: item.id },
                  "Marked outbox item delivered",
                );
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              options.logger.error(
                { event: "outbox.enqueue_error", outboxId: item.id, error: message },
                "Failed to enqueue outbox item",
              );
              await markOutboxFailed(
                options.database,
                item.id,
                options.workerId,
                message,
              );
            }
          };

          for (let offset = 0; offset < items.length; offset += options.concurrency) {
            await Promise.all(items.slice(offset, offset + options.concurrency).map(deliver));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.logger.error(
          { event: "outbox.poll_error", error: message },
          "Failed to poll outbox",
        );
      }
    })();

    inFlight = job;
    try {
      await job;
    } finally {
      if (inFlight === job) inFlight = null;
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      options.logger.info(
        {
          event: "outbox.start",
          pollIntervalMs: options.pollIntervalMs,
          batchSize: options.batchSize,
          concurrency: options.concurrency,
        },
        "Outbox dispatcher started",
      );
      timer = options.timers.setInterval(() => {
        void poll();
      }, options.pollIntervalMs);
      void poll();
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      options.logger.info({ event: "outbox.shutdown" }, "Outbox dispatcher shutting down");
      if (timer !== null) {
        options.timers.clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight;
      }
      running = false;
    },
  };
}
