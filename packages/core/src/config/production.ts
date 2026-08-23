export type Environment = 'local' | 'test' | 'staging' | 'production';

export interface ProductionConfig {
  environment: Environment;
  errors: string[];
  valid: boolean;
}

export type ProductionService = 'all' | 'web' | 'worker';

const KNOWN_DEFAULT_PASSWORDS = [
  'leadops_dev',
  'leadops_runtime_dev',
  'leadops_worker_dev',
  'leadops_worker_test_dev',
  'leadops_runtime_test_dev',
  'password',
  'changeme',
  'dev_password',
];

const KNOWN_DEFAULT_SECRETS = [
  'better-auth-secret-change-me',
  'change-me-please',
  '0000000000000000000000000000000000000000000000000000000000000000',
];

function urlHasDefaultPassword(url: string): boolean {
  try {
    const pwd = new URL(url).password;
    if (!pwd) return false;
    return KNOWN_DEFAULT_PASSWORDS.includes(pwd);
  } catch {
    return true;
  }
}

function isValidPostgresUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      parsed.username.length > 0 &&
      parsed.password.length > 0 &&
      parsed.hostname.length > 0 &&
      parsed.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function urlUsesTestRole(url: string): boolean {
  try {
    return new URL(url).username.includes('_test');
  } catch {
    return false;
  }
}

function isValidHex64(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}

function resolveEnvironment(env: NodeJS.ProcessEnv): Environment {
  // Using explicit type assertion because Next.js narrows ProcessEnv.NODE_ENV
  // to a union type that excludes 'staging' at compile time.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const nodeEnv = (env.NODE_ENV as string | undefined) ?? '';
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'test';
  if (nodeEnv === 'staging') return 'staging';
  return 'local';
}

export function validateProductionConfig(
  env: NodeJS.ProcessEnv,
  service: ProductionService = 'all',
): ProductionConfig {
  const environment = resolveEnvironment(env);
  const errors: string[] = [];
  const isProduction = environment === 'production';
  const isStaging = environment === 'staging';
  const isStrict = isProduction || isStaging;

  if (isStrict && env.LEADOPS_DEMO_MODE === 'true') {
    errors.push('LEADOPS_DEMO_MODE must not be enabled in ' + environment);
  }

  // --- Database ---
  const runtimeUrl = env.DATABASE_URL ?? '';
  const workerUrl = env.WORKER_DATABASE_URL ?? '';

  if (isStrict && (service === 'all' || service === 'web')) {
    if (!isValidPostgresUrl(runtimeUrl)) {
      errors.push('DATABASE_URL must be a complete PostgreSQL connection URL');
    } else if (urlHasDefaultPassword(runtimeUrl)) {
      errors.push('DATABASE_URL contains a default password');
    }
    if (urlUsesTestRole(runtimeUrl)) {
      errors.push('DATABASE_URL uses a test role');
    }
  }
  if (isStrict && (service === 'all' || service === 'worker')) {
    if (!isValidPostgresUrl(workerUrl)) {
      errors.push('WORKER_DATABASE_URL must be a complete PostgreSQL connection URL');
    } else if (urlHasDefaultPassword(workerUrl)) {
      errors.push('WORKER_DATABASE_URL contains a default password');
    }
    if (urlUsesTestRole(workerUrl)) {
      errors.push('WORKER_DATABASE_URL uses a test role');
    }
  }

  // --- External alerting ---
  if (isStrict && (service === 'all' || service === 'worker')) {
    try {
      const alertUrl = new URL(env.ALERT_WEBHOOK_URL ?? '');
      if (alertUrl.protocol !== 'https:' || alertUrl.username || alertUrl.password) {
        errors.push('ALERT_WEBHOOK_URL must be a credential-free HTTPS URL');
      }
    } catch {
      errors.push('ALERT_WEBHOOK_URL must be a valid HTTPS URL');
    }
  }

  // --- Encryption ---
  const encryptionKey = env.LEADOPS_ENCRYPTION_KEY ?? '';
  if (isStrict) {
    if (!isValidHex64(encryptionKey)) {
      errors.push('LEADOPS_ENCRYPTION_KEY must be exactly 64 hex characters');
    }
    if (encryptionKey.length > 0 && KNOWN_DEFAULT_SECRETS.includes(encryptionKey)) {
      errors.push('LEADOPS_ENCRYPTION_KEY uses a known default value');
    }
  }

  // --- Auth ---
  const authSecret = env.BETTER_AUTH_SECRET ?? '';
  const authUrl = env.BETTER_AUTH_URL ?? '';

  if (isStrict && (service === 'all' || service === 'web')) {
    if (!authSecret || authSecret.length < 16) {
      errors.push('BETTER_AUTH_SECRET is required and must be at least 16 characters');
    }
    if (authSecret.length > 0 && KNOWN_DEFAULT_SECRETS.includes(authSecret)) {
      errors.push('BETTER_AUTH_SECRET uses a known default value');
    }
    if (!authUrl || authUrl.length === 0) {
      errors.push('BETTER_AUTH_URL is required');
    }
  }

  // --- AI Provider ---
  const aiProvider = env.AI_PROVIDER ?? '';
  const aiApiKey = env.AI_API_KEY ?? '';

  if (isStrict && (service === 'all' || service === 'worker')) {
    if (!aiProvider || aiProvider === 'fake') {
      errors.push('AI_PROVIDER cannot be "fake" in ' + environment);
    }
    if (aiProvider && aiProvider !== 'fake') {
      if (!aiApiKey || aiApiKey.length < 8) {
        errors.push('AI_API_KEY is required when using real AI provider');
      }
    }
  }

  // --- Email Provider ---
  const emailProvider = env.EMAIL_PROVIDER ?? '';
  const emailApiKey = env.RESEND_API_KEY ?? '';
  const emailFrom = env.RESEND_FROM ?? '';

  if (isStrict && (service === 'all' || service === 'worker')) {
    if (!emailProvider || emailProvider === 'fake') {
      errors.push('EMAIL_PROVIDER cannot be "fake" in ' + environment);
    }
    if (emailProvider && emailProvider !== 'fake') {
      if (!emailApiKey || emailApiKey.length < 8) {
        errors.push('RESEND_API_KEY is required for production email');
      }
      if (!emailFrom) {
        errors.push('RESEND_FROM is required for production email');
      }
    }
  }

  // --- Telemetry ---
  if (isStrict) {
    if (env.OTEL_ENABLED !== 'true') {
      errors.push('OTEL_ENABLED must be "true" in ' + environment);
    }
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        errors.push('OTEL_EXPORTER_OTLP_ENDPOINT must use HTTP or HTTPS');
      }
    } catch {
      errors.push('OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL');
    }
  }

  // --- CORS ---
  const corsOrigin = env.CORS_ORIGIN ?? '';
  if (isStrict && (service === 'all' || service === 'web')) {
    if (corsOrigin === '*' || corsOrigin === '') {
      errors.push('CORS_ORIGIN must be explicitly configured (must not be "*")');
    }
  }

  return {
    environment,
    errors,
    valid: errors.length === 0,
  };
}
