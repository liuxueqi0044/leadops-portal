import type postgres from "postgres";
import type { Logger } from "pino";
import type PgBoss from "pg-boss";
import { GENERATION_VERSION } from "@leadops/core";

export interface SchedulerOptions {
  logger: Logger;
  sql: postgres.Sql;
  workerId: string;
  pollIntervalMs: number;
  batchSize: number;
  getBoss: () => PgBoss | null;
}

export function createApprovalExpireScheduler(options: SchedulerOptions) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (stopping || inFlight) return;

    const work = (async () => {
      try {
        const rows = await options.sql.unsafe(
          `SELECT "organizationId", "clientId", "integrationId"
           FROM list_due_approval_expiration_jobs($1::integer)`,
          [options.batchSize],
        ) as { organizationId: string; clientId: string; integrationId: string }[];

        const boss = options.getBoss();
        if (!boss) return;

        for (const row of rows) {
          const jobId = "approvals-expire-" + row.integrationId;
          await boss.send("approvals.expire", {
            schemaVersion: 1,
            organizationId: row.organizationId,
            clientId: row.clientId,
            integrationId: row.integrationId,
          }, {
            singletonKey: jobId,
            singletonSeconds: 60,
            retryLimit: 5,
            retryDelay: 5,
            retryBackoff: true,
          });
        }

        if (rows.length > 0) {
          options.logger.info(
            { event: "approvals.expire.scheduled", count: rows.length },
            "Scheduled approval expiration for " + String(rows.length) + " tenants",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.logger.error(
          { event: "approvals.expire.scheduler_error", error: message },
          "Approval expire scheduler error",
        );
      }
    })();

    inFlight = work;
    try { await work; } finally { if (inFlight === work) inFlight = null; }
  };

  return {
    start(): void {
      stopping = false;
      timer = globalThis.setInterval(() => { void poll(); }, options.pollIntervalMs);
      void poll();
    },
    runOnce: poll,
    async shutdown(): Promise<void> {
      stopping = true;
      if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
      if (inFlight) await inFlight;
    },
  };
}

export function createApprovalDeliveryEnqueueScheduler(options: SchedulerOptions) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (stopping || inFlight) return;

    const work = (async () => {
      try {
        const rows = await options.sql.unsafe(
          `SELECT id, "organizationId", "clientId", "integrationId"
           FROM list_due_approval_delivery_jobs($1::integer)`,
          [options.batchSize],
        ) as {
          id: string; organizationId: string; clientId: string;
          integrationId: string;
        }[];

        const boss = options.getBoss();
        if (!boss) return;

        for (const row of rows) {
          const jobId = "approval-delivery-" + row.id;
          await boss.send("approvals.deliver-result", {
            schemaVersion: 1,
            deliveryId: row.id,
            organizationId: row.organizationId,
            clientId: row.clientId,
            integrationId: row.integrationId,
          }, {
            singletonKey: jobId,
            singletonSeconds: 60,
            retryLimit: 10,
            retryDelay: 5,
            retryBackoff: true,
          });
        }

        if (rows.length > 0) {
          options.logger.info(
            { event: "approvals.deliver.enqueued", count: rows.length },
            "Enqueued " + String(rows.length) + " approval deliveries",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.logger.error(
          { event: "approvals.deliver.scheduler_error", error: message },
          "Approval delivery scheduler error",
        );
      }
    })();

    inFlight = work;
    try { await work; } finally { if (inFlight === work) inFlight = null; }
  };

  return {
    start(): void {
      stopping = false;
      timer = globalThis.setInterval(() => { void poll(); }, options.pollIntervalMs);
      void poll();
    },
    runOnce: poll,
    async shutdown(): Promise<void> {
      stopping = true;
      if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
      if (inFlight) await inFlight;
    },
  };
}

export function createEmailDeliveryEnqueueScheduler(options: SchedulerOptions) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (stopping || inFlight) return;

    const work = (async () => {
      try {
        const rows = await options.sql.unsafe(
          `SELECT id, "organizationId", "clientId", "integrationId"
            FROM list_due_email_delivery_jobs($1::integer)`,
          [options.batchSize],
        ) as {
          id: string; organizationId: string; clientId: string; integrationId: string;
        }[];

        const boss = options.getBoss();
        if (!boss) return;

        for (const row of rows) {
          const jobId = "email-send-" + row.id;
          await boss.send("emails.send", {
            schemaVersion: 1,
            deliveryId: row.id,
            organizationId: row.organizationId,
            clientId: row.clientId,
            integrationId: row.integrationId,
          }, {
            singletonKey: jobId,
            singletonSeconds: 60,
            retryLimit: 5,
            retryDelay: 5,
            retryBackoff: true,
          });
        }

        if (rows.length > 0) {
          options.logger.info(
            { event: "emails.send.enqueued", count: rows.length },
            "Enqueued " + String(rows.length) + " email deliveries",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.logger.error(
          { event: "emails.send.scheduler_error", error: message },
          "Email delivery scheduler error",
        );
      }
    })();

    inFlight = work;
    try { await work; } finally { if (inFlight === work) inFlight = null; }
  };

  return {
    start(): void {
      stopping = false;
      timer = globalThis.setInterval(() => { void poll(); }, options.pollIntervalMs);
      void poll();
    },
    runOnce: poll,
    async shutdown(): Promise<void> {
      stopping = true;
      if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
      if (inFlight) await inFlight;
    },
  };
}

export function createWeeklyReportScheduler(options: SchedulerOptions) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (stopping || inFlight) return;

    const work = (async () => {
      try {
        const rows = await options.sql.unsafe(
          `SELECT "organizationId", "clientId", "integrationId",
                  "periodStart", "periodEnd"
           FROM list_due_weekly_report_clients($1::integer, $2::integer)`,
          [options.batchSize, GENERATION_VERSION],
        ) as {
          organizationId: string; clientId: string; integrationId: string;
          periodStart: string | Date; periodEnd: string | Date;
        }[];

        const boss = options.getBoss();
        if (!boss) return;

        for (const row of rows) {
          // postgres.js can return a timestamptz from a record-returning
          // function as PostgreSQL text. Normalize both driver representations
          // before the strict job schema sees the payload.
          const startDate = row.periodStart instanceof Date ? row.periodStart : new Date(row.periodStart);
          const endDate = row.periodEnd instanceof Date ? row.periodEnd : new Date(row.periodEnd);
          if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            throw new Error('Weekly report discovery returned an invalid period');
          }
          const periodStart = startDate.toISOString();
          const periodEnd = endDate.toISOString();
          const jobId = "weekly-report-" + String(GENERATION_VERSION) + "-" + row.organizationId + "-" + row.clientId + "-" + periodStart.slice(0, 10);
          await boss.send("reports.generate-weekly", {
            schemaVersion: 1,
            organizationId: row.organizationId,
            clientId: row.clientId,
            integrationId: row.integrationId,
            periodStart,
            periodEnd,
            correlationId: jobId,
          }, {
            singletonKey: jobId,
            singletonSeconds: 3600,
            retryLimit: 3,
            retryDelay: 10,
            retryBackoff: true,
          });
        }

        if (rows.length > 0) {
          options.logger.info(
            { event: "reports.weekly.scheduled", count: rows.length },
            "Scheduled weekly reports for " + String(rows.length) + " clients",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.logger.error(
          { event: "reports.weekly.scheduler_error", error: message },
          "Weekly report scheduler error",
        );
      }
    })();

    inFlight = work;
    try { await work; } finally { if (inFlight === work) inFlight = null; }
  };

  return {
    start(): void {
      stopping = false;
      timer = globalThis.setInterval(() => { void poll(); }, options.pollIntervalMs);
      void poll();
    },
    runOnce: poll,
    async shutdown(): Promise<void> {
      stopping = true;
      if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
      if (inFlight) await inFlight;
    },
  };
}


export function createRetentionScheduler(options: SchedulerOptions) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (stopping || inFlight) return;

    const work = (async () => {
      try {
        const boss = options.getBoss();
        if (!boss) return;

        const dryRun = process.env.RETENTION_ENABLED !== 'true';
        const jobId = 'retention-prune-daily';

        await boss.send('retention.prune-non-audit-data', {
          schemaVersion: 1,
          dryRun,
        }, {
          singletonKey: jobId,
          singletonSeconds: 86400,
          retryLimit: 2,
          retryDelay: 10,
          retryBackoff: true,
        });

        options.logger.info(
          { event: 'retention.scheduled', dryRun },
          'Retention prune scheduled (dryRun=' + String(dryRun) + ')',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.logger.error(
          { event: 'retention.scheduler_error', error: message },
          'Retention scheduler error',
        );
      }
    })();

    inFlight = work;
    try { await work; } finally { if (inFlight === work) inFlight = null; }
  };

  return {
    start(): void {
      stopping = false;
      timer = globalThis.setInterval(() => { void poll(); }, options.pollIntervalMs);
      void poll();
    },
    runOnce: poll,
    async shutdown(): Promise<void> {
      stopping = true;
      if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
      if (inFlight) await inFlight;
    },
  };
}
