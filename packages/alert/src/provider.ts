import type { AlertProvider, AlertProviderType } from './types.js';
import { createFakeAlertProvider } from './fake-provider.js';
import { createWebhookAlertProvider } from './webhook-provider.js';

export interface CreateAlertProviderOptions {
  type: AlertProviderType;
  webhookUrl?: string;
  timeoutMs?: number;
  validateUrl?: boolean;
}

export function createAlertProvider(options: CreateAlertProviderOptions): AlertProvider {
  switch (options.type) {
    case 'fake':
      return createFakeAlertProvider();
    case 'webhook':
      if (!options.webhookUrl) {
        throw new Error('Webhook URL is required for webhook alert provider');
      }
      return createWebhookAlertProvider({
        webhookUrl: options.webhookUrl,
        timeoutMs: options.timeoutMs,
        validateUrl: options.validateUrl ?? true,
      });
    default:
      throw new Error(`Unknown alert provider type: ${options.type as string}`);
  }
}
