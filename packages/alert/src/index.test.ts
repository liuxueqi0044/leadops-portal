import { describe, expect, it } from 'vitest';
import { createFakeAlertProvider } from './fake-provider.js';
import { createWebhookAlertProvider } from './webhook-provider.js';

describe('createFakeAlertProvider', () => {
  it('sends alert and returns ok', async () => {
    const provider = createFakeAlertProvider();

    const result = await provider.send({
      body: {
        severity: 'critical',
        category: 'web_5xx_threshold',
        title: 'Test alert',
        message: '5xx rate exceeded threshold',
        value: 15,
        threshold: 10,
        service: 'web',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'test-key-1',
    });

    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toBe('fake-alert-1');
  });

  it('simulates retryable failure', async () => {
    const provider = createFakeAlertProvider({ failureMode: 'retryable' });

    const result = await provider.send({
      body: {
        severity: 'warning',
        category: 'queue_backlog',
        title: 'Queue backlog',
        message: 'Queue is growing',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'test-key-2',
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('simulates permanent failure', async () => {
    const provider = createFakeAlertProvider({ failureMode: 'permanent' });

    const result = await provider.send({
      body: {
        severity: 'info',
        category: 'queue_backlog',
        title: 'Test',
        message: 'Test',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'test-key-3',
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('returns unique message IDs', async () => {
    const provider = createFakeAlertProvider();

    const r1 = await provider.send({
      body: {
        severity: 'info',
        category: 'queue_backlog',
        title: 'A1',
        message: 'M1',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'k1',
    });

    const r2 = await provider.send({
      body: {
        severity: 'info',
        category: 'queue_backlog',
        title: 'A2',
        message: 'M2',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'k2',
    });

    expect(r1.providerMessageId).not.toBe(r2.providerMessageId);
  });

  it('respects AbortSignal', async () => {
    const provider = createFakeAlertProvider({ latencyMs: 1000 });
    const controller = new AbortController();
    controller.abort();

    const result = await provider.send({
      body: {
        severity: 'info',
        category: 'queue_backlog',
        title: 'Test',
        message: 'Test',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'test-aborted',
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
  });
});

describe('createWebhookAlertProvider', () => {
  it('rejects private IP URLs', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://127.0.0.1:8080/alert' }),
    ).toThrow('URL validation failed');
  });

  it('rejects loopback URLs', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://localhost/alert' }),
    ).toThrow('URL validation failed');
  });

  it('rejects metadata service URLs', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://169.254.169.254/alert' }),
    ).toThrow('URL validation failed');
  });

  it('rejects google metadata URLs', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://metadata.google.internal/alert' }),
    ).toThrow('URL validation failed');
  });

  it('rejects HTTP URLs', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'http://example.com/alert' }),
    ).toThrow('URL validation failed');
  });

  it('rejects URLs with credentials', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://user:pass@example.com/alert' }),
    ).toThrow('URL validation failed');
  });

  it('rejects private network URLs', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://192.168.1.1/alert' }),
    ).toThrow('URL validation failed');

    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://10.0.0.1/alert' }),
    ).toThrow('URL validation failed');

    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://172.16.0.1/alert' }),
    ).toThrow('URL validation failed');
  });

  it('accepts valid public HTTPS URL', () => {
    expect(() =>
      createWebhookAlertProvider({ webhookUrl: 'https://hooks.example.com/alert' }),
    ).not.toThrow();
  });

  it('skips URL validation when validateUrl is false', () => {
    expect(() =>
      createWebhookAlertProvider({
        webhookUrl: 'http://localhost:9999/alert',
        validateUrl: false,
      }),
    ).not.toThrow();
  });

  it('rejects a hostname that resolves to a private address before connecting', async () => {
    const provider = createWebhookAlertProvider({
      webhookUrl: 'https://hooks.example.com/alert',
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    const result = await provider.send({
      body: {
        severity: 'critical',
        category: 'queue_dead_letter',
        title: 'Private resolution',
        message: 'must not connect',
        timestamp: new Date().toISOString(),
      },
      idempotencyKey: 'private-dns',
    });

    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
