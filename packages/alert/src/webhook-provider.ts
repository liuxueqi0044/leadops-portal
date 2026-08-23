import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import {
  parseCallbackUrl,
  resolveCallbackUrl,
  UnsafeCallbackUrlError,
  type CallbackDnsLookup,
  type ResolvedCallbackUrl,
} from '@leadops/core';

import type { AlertProvider, AlertSendRequest, AlertSendResult } from './types.js';

function boundLookup(target: ResolvedCallbackUrl): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

async function postBound(
  target: ResolvedCallbackUrl,
  body: string,
  idempotencyKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; requestId?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      protocol: 'https:',
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': idempotencyKey,
        'user-agent': 'LeadOps-Portal/1.0',
      },
      lookup: boundLookup(target),
      // Node expects an unbracketed DNS name for SNI.  Literal IPv6 targets do
      // not use SNI and have already been validated and bound by lookup.
      servername: target.url.hostname.startsWith('[') ? undefined : target.url.hostname,
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const requestId = response.headers['x-request-id'];
      response.resume();
      response.once('end', () => {
        resolve({
          status,
          ...(typeof requestId === 'string' ? { requestId } : {}),
        });
      });
    });
    const abort = (): void => {
      const error = new Error('Alert request aborted');
      error.name = 'AbortError';
      req.destroy(error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    req.once('timeout', abort);
    req.once('error', reject);
    req.once('close', () => signal?.removeEventListener('abort', abort));
    req.end(body);
  });
}

export interface WebhookAlertProviderOptions {
  webhookUrl: string;
  timeoutMs?: number;
  validateUrl?: boolean;
  lookup?: CallbackDnsLookup;
}

export function createWebhookAlertProvider(options: WebhookAlertProviderOptions): AlertProvider {
  if (options.validateUrl !== false) {
    try {
      const parsed = parseCallbackUrl(options.webhookUrl);
      if (parsed.hostname.toLowerCase() === 'metadata.google.internal') {
        throw new Error('metadata endpoint is not allowed');
      }
    } catch {
      throw new Error('Alert webhook URL validation failed');
    }
  }
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async send(request: AlertSendRequest): Promise<AlertSendResult> {
      let target: ResolvedCallbackUrl;
      try {
        target = await resolveCallbackUrl(options.webhookUrl, { lookup: options.lookup });
      } catch (error) {
        return {
          ok: false,
          error: 'Alert webhook address is not safe or cannot be resolved',
          retryable: !(error instanceof UnsafeCallbackUrlError),
        };
      }

      const body = JSON.stringify({ ...request.body, idempotencyKey: request.idempotencyKey });
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      try {
        const response = await postBound(target, body, request.idempotencyKey, timeoutMs, signal);
        if (response.status >= 200 && response.status < 300) {
          return {
            ok: true,
            providerMessageId: response.requestId ?? `webhook-${request.idempotencyKey}`,
            retryable: false,
          };
        }
        const retryable = response.status === 429 || response.status >= 500;
        return {
          ok: false,
          error: `Webhook returned ${String(response.status)}`,
          retryable,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error && error.name === 'AbortError'
            ? 'Request timed out or was aborted'
            : 'Alert webhook network error',
          retryable: true,
        };
      }
    },
  };
}
