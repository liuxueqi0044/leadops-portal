import type { AlertProvider, AlertSendRequest, AlertSendResult } from './types.js';

export interface FakeAlertProviderOptions {
  failureMode?: 'none' | 'retryable' | 'permanent' | 'timeout';
  latencyMs?: number;
}

export function createFakeAlertProvider(options: FakeAlertProviderOptions = {}): AlertProvider {
  let messageCounter = 0;
  const failureMode = options.failureMode ?? 'none';
  const latencyMs = options.latencyMs ?? 0;

  return {
    async send(request: AlertSendRequest): Promise<AlertSendResult> {
      messageCounter += 1;

      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }

      if (request.signal?.aborted) {
        return { ok: false, error: 'Aborted', retryable: true };
      }

      switch (failureMode) {
        case 'retryable':
          return { ok: false, error: 'Simulated retryable failure', retryable: true };
        case 'permanent':
          return { ok: false, error: 'Simulated permanent failure', retryable: false };
        case 'timeout':
          if (request.signal && !request.signal.aborted) {
            return { ok: false, error: 'Simulated timeout', retryable: true };
          }
          return { ok: false, error: 'Simulated timeout', retryable: true };
        case 'none':
        default:
          return {
            ok: true,
            providerMessageId: `fake-alert-${String(messageCounter)}`,
            retryable: false,
          };
      }
    },
  };
}
