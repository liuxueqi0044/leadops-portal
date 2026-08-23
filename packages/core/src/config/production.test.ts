import { describe, expect, it } from 'vitest';

import { validateProductionConfig } from './production.js';

const shared = {
  NODE_ENV: 'production',
  LEADOPS_ENCRYPTION_KEY: 'a'.repeat(64),
  OTEL_ENABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
};

describe('production configuration boundaries', () => {
  it('validates the web without requiring worker-only credentials', () => {
    const result = validateProductionConfig(
      {
        ...shared,
        DATABASE_URL: 'postgresql://leadops_runtime:unique-runtime-secret@db.example.com/leadops',
        BETTER_AUTH_SECRET: 'unique-auth-secret-for-production',
        BETTER_AUTH_URL: 'https://portal.example.com',
        CORS_ORIGIN: 'https://portal.example.com',
      },
      'web',
    );

    expect(result).toEqual(expect.objectContaining({ valid: true, errors: [] }));
  });

  it('validates the worker without requiring web-only credentials', () => {
    const result = validateProductionConfig(
      {
        ...shared,
        WORKER_DATABASE_URL:
          'postgresql://leadops_worker:unique-worker-secret@db.example.com/leadops',
        AI_PROVIDER: 'openai',
        AI_API_KEY: 'ai-production-key',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_production_key',
        RESEND_FROM: 'LeadOps <ops@example.com>',
        ALERT_WEBHOOK_URL: 'https://alerts.example.com/leadops',
      },
      'worker',
    );

    expect(result).toEqual(expect.objectContaining({ valid: true, errors: [] }));
  });

  it('fails closed when telemetry or a service database credential is absent', () => {
    const result = validateProductionConfig(
      {
        NODE_ENV: 'staging',
        LEADOPS_ENCRYPTION_KEY: 'b'.repeat(64),
        BETTER_AUTH_SECRET: 'unique-auth-secret-for-staging',
        BETTER_AUTH_URL: 'https://staging.example.com',
        CORS_ORIGIN: 'https://staging.example.com',
      },
      'web',
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DATABASE_URL'),
        expect.stringContaining('OTEL_ENABLED'),
        expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT'),
      ]),
    );
  });

  it('rejects explicit demo mode in production', () => {
    const result = validateProductionConfig(
      {
        ...shared,
        LEADOPS_DEMO_MODE: 'true',
        DATABASE_URL: 'postgresql://leadops_runtime:unique-runtime-secret@db.example.com/leadops',
        BETTER_AUTH_SECRET: 'unique-auth-secret-for-production',
        BETTER_AUTH_URL: 'https://portal.example.com',
        CORS_ORIGIN: 'https://portal.example.com',
      },
      'web',
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('LEADOPS_DEMO_MODE must not be enabled in production');
  });
});
