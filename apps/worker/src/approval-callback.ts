import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import {
  isPublicCallbackAddress,
  parseCallbackUrl,
  resolveCallbackUrl,
  UnsafeCallbackUrlError,
  type CallbackDnsLookup,
  type ResolvedCallbackUrl,
} from '@leadops/core';
import {
  claimApprovalDeliveries,
  markApprovalDeliveryDelivered,
  markApprovalDeliveryFailed,
} from '@leadops/db';
import { signWebhook } from '@leadops/events';
import { createLogger } from '@leadops/observability';
import type postgres from 'postgres';

import type { WorkerRuntimeTimers } from './runtime.js';

const log = createLogger({ service: 'worker:approval-callback' });

export interface CallbackPayload {
  eventType: string;
  approvalId: string;
  leadId?: string | null;
  decision?: string | null;
  status?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionReason?: string | null;
  version?: number | null;
}

export interface CallbackResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  retryable: boolean;
}

export interface CallbackDeliveryOptions {
  allowLocalhost?: boolean;
  lookup?: CallbackDnsLookup;
  timeoutMs?: number;
  now?: () => Date;
}

export function parseCallbackPayload(value: Record<string, unknown>): CallbackPayload | null {
  if (typeof value.eventType !== 'string' || typeof value.approvalId !== 'string') return null;
  return {
    eventType: value.eventType,
    approvalId: value.approvalId,
    leadId: typeof value.leadId === 'string' ? value.leadId : null,
    decision: typeof value.decision === 'string' ? value.decision : null,
    status: typeof value.status === 'string' ? value.status : null,
    decidedBy: typeof value.decidedBy === 'string' ? value.decidedBy : null,
    decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : null,
    decisionReason: typeof value.decisionReason === 'string' ? value.decisionReason : null,
    version: typeof value.version === 'number' ? value.version : null,
  };
}

export class UnsafeUrlError extends UnsafeCallbackUrlError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** Compatibility wrapper used by the worker tests and registration contract. */
export class SafeUrlValidator {
  constructor(
    private readonly allowLocalhost = false,
    private readonly lookup?: CallbackDnsLookup,
  ) {}

  validateUrlString(input: string): URL {
    try {
      return parseCallbackUrl(input, { allowLocalhost: this.allowLocalhost });
    } catch (error) {
      if (error instanceof UnsafeCallbackUrlError) throw new UnsafeUrlError(error.message);
      throw error;
    }
  }

  async validateDnsAndResolve(hostname: string): Promise<string> {
    const formatted = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    try {
      const resolved = await resolveCallbackUrl(`https://${formatted}/`, {
        allowLocalhost: this.allowLocalhost,
        lookup: this.lookup,
      });
      return resolved.address;
    } catch (error) {
      if (error instanceof UnsafeCallbackUrlError) throw new UnsafeUrlError(error.message);
      throw error;
    }
  }

  isSafeIp(address: string): boolean {
    return isPublicCallbackAddress(address, { allowLocalhost: this.allowLocalhost });
  }
}

function boundLookup(target: ResolvedCallbackUrl): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

async function postBoundCallback(
  target: ResolvedCallbackUrl,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  const request = target.url.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers,
        lookup: boundLookup(target),
        servername:
          target.url.protocol === 'https:' && target.url.hostname.startsWith('[')
            ? undefined
            : target.url.hostname,
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        response.once('end', () => {
          resolve(status);
        });
      },
    );

    req.once('timeout', () => {
      const timeoutError = new Error('callback timed out');
      timeoutError.name = 'AbortError';
      req.destroy(timeoutError);
    });
    req.once('error', reject);
    req.end(body);
  });
}

export async function deliverApprovalCallback(
  payload: CallbackPayload,
  integrationUrl: string,
  integrationSecret: string | undefined,
  idempotencyKey: string,
  deliveryId: string,
  options: CallbackDeliveryOptions = {},
): Promise<CallbackResult> {
  if (!integrationSecret) {
    return { success: false, error: 'missing integration secret', retryable: false };
  }

  let target: ResolvedCallbackUrl;
  try {
    target = await resolveCallbackUrl(integrationUrl, {
      allowLocalhost: options.allowLocalhost,
      lookup: options.lookup,
    });
  } catch (error) {
    if (error instanceof UnsafeCallbackUrlError) {
      log.error({ deliveryId, errorCode: 'UNSAFE_CALLBACK_URL' }, 'unsafe callback URL rejected');
      return { success: false, error: error.message, retryable: false };
    }
    return { success: false, error: 'callback DNS resolution failed', retryable: true };
  }

  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 100 * 1024) {
    return { success: false, error: 'callback body is too large', retryable: false };
  }

  const timestampDate = (options.now ?? (() => new Date()))();
  const timestamp = String(Math.floor(timestampDate.getTime() / 1000));
  const signature = signWebhook(integrationSecret, idempotencyKey, timestampDate, body).signature;
  const headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'user-agent': 'LeadOps-Portal/1.0',
    'webhook-id': idempotencyKey,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
    'x-leadops-idempotency-key': idempotencyKey,
  };

  try {
    const statusCode = await postBoundCallback(
      target,
      body,
      headers,
      options.timeoutMs ?? 30_000,
    );
    if (statusCode >= 200 && statusCode < 300) {
      return { success: true, statusCode, retryable: false };
    }

    const retryable = statusCode === 429 || statusCode >= 500;
    log.warn(
      { deliveryId, statusCode, retryable },
      'approval callback received non-success status',
    );
    return {
      success: false,
      statusCode,
      error: `callback returned ${String(statusCode)}`,
      retryable,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    log.warn({ deliveryId, timedOut }, 'approval callback network error');
    return {
      success: false,
      error: timedOut ? 'callback timed out' : 'callback network error',
      retryable: true,
    };
  }
}

export async function processApprovalDeliveries(
  sql: postgres.Sql,
  workerId: string,
  batchSize = 10,
  options: CallbackDeliveryOptions = {},
): Promise<number> {
  const deliveries = await claimApprovalDeliveries(sql, workerId, batchSize);
  let processed = 0;

  for (const delivery of deliveries) {
    let result: CallbackResult;
    if (delivery.messageType !== 'approval.completed') {
      result = { success: false, error: 'unsupported delivery message type', retryable: false };
    } else if (!delivery.callbackUrl) {
      result = { success: false, error: 'missing registered callback URL', retryable: false };
    } else {
      const payload = parseCallbackPayload(delivery.payload);
      if (!payload) {
        await markApprovalDeliveryFailed(
          sql,
          delivery.id,
          workerId,
          'invalid callback payload',
          false,
        );
        processed++;
        continue;
      }
      result = await deliverApprovalCallback(
        payload,
        delivery.callbackUrl,
        delivery.secret ?? undefined,
        delivery.idempotencyKey,
        delivery.id,
        options,
      );
    }

    if (result.success) {
      await markApprovalDeliveryDelivered(sql, delivery.id, workerId);
    } else {
      await markApprovalDeliveryFailed(
        sql,
        delivery.id,
        workerId,
        result.error ?? 'callback failed',
        result.retryable,
      );
    }
    processed++;
  }

  return processed;
}

export interface ApprovalDeliveryDispatcherOptions {
  database: postgres.Sql;
  workerId: string;
  pollIntervalMs: number;
  batchSize: number;
  timers: WorkerRuntimeTimers;
  callback?: CallbackDeliveryOptions;
}

export function createApprovalDeliveryDispatcher(options: ApprovalDeliveryDispatcherOptions) {
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const poll = async (): Promise<void> => {
    if (stopping || inFlight) return;
    const current = processApprovalDeliveries(
      options.database,
      options.workerId,
      options.batchSize,
      options.callback,
    ).then(() => undefined);
    inFlight = current;
    try {
      await current;
    } catch (error) {
      log.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'approval delivery poll failed',
      );
    } finally {
      if (inFlight === current) inFlight = null;
    }
  };

  return {
    start(): void {
      if (timer !== null) return;
      stopping = false;
      timer = options.timers.setInterval(() => void poll(), options.pollIntervalMs);
      void poll();
    },
    async shutdown(): Promise<void> {
      stopping = true;
      if (timer !== null) options.timers.clearInterval(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
  };
}
