import pino, { type DestinationStream, type Logger } from 'pino';
import { randomUUID } from 'node:crypto';

const REDACT_PATHS = [
  'DATABASE_URL',
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'key',
  'apikey',
  'api_key',
  'apiKey',
  'API_KEY',
  'pass',
  'credential',
  'credentials',
  'jwt',
  'encryptionKey',
  'encryption_key',
  'ENCRYPTION_KEY',
  'to_email',
  '*.DATABASE_URL',
  '*.password',
  '*.secret',
  '*.token',
  '*.authorization',
  '*.cookie',
  '*.credential',
  '*.credentials',
  '*.credentials.*',
  '*.apiKey',
  '*.api_key',
  '*.API_KEY',
  '*.encryptionKey',
  '*.encryption_key',
  '*.ENCRYPTION_KEY',
  'headers.authorization',
  'headers.cookie',
  'headers.*.authorization',
  'headers.*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'body',
  '*.body',
  'payload',
  '*.payload',
  'emailBody',
  '*.emailBody',
  'htmlBody',
  '*.htmlBody',
  'textBody',
  '*.textBody',
  'subject',
  '*.subject',
  '*.to_email',
  'span.attributes.secret',
  'span.attributes.token',
  'span.attributes.key',
  'span.attributes.credentials',
  'span.attributes.prompt',
  'span.attributes.response',
  'span.attributes.*.secret',
  'span.attributes.*.token',
  'span.attributes.*.key',
  'span.attributes.*.credentials',
  'span.attributes.*.prompt',
  'span.attributes.*.response',
];

export interface CreateLoggerOptions {
  service: string;
  instanceId?: string;
  level?: string;
  destination?: DestinationStream;
  pretty?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const instanceId = options.instanceId ?? randomUUID();
  const pretty =
    options.pretty ??
    (process.env.NODE_ENV === 'development' && options.destination === undefined);

  const loggerOptions = {
    name: `leadops-${options.service}`,
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { instanceId },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    transport: pretty ? { target: 'pino-pretty' } : undefined,
  };

  return options.destination
    ? pino(loggerOptions, options.destination)
    : pino(loggerOptions);
}

export interface SafeError {
  name: string;
  message: string;
  code?: string;
}

export function serializeSafeError(error: unknown): SafeError {
  const fallback: SafeError = {
    name: 'Error',
    message: 'Internal operation failed',
  };

  if (error instanceof Error) {
    const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : 'Error';
    const candidateCode = (error as Error & { code?: unknown }).code;
    const code =
      typeof candidateCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidateCode)
        ? candidateCode
        : undefined;

    return code
      ? { name, message: 'Internal operation failed', code }
      : { name, message: 'Internal operation failed' };
  }

  return fallback;
}

export {
  generateCorrelationId,
  validateCorrelationId,
  extractOrGenerateCorrelationId,
  correlationHeaderName,
  sanitizeCorrelationIdForLog,
} from './correlation.js';

export {
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  getTelemetryConfig,
  type TelemetryConfig,
  type TelemetryEnvironment,
  type Meter,
  metrics,
  trace,
  type Tracer,
  type Span,
  SpanStatusCode,
} from './telemetry.js';

export {
  recordHttpRequest,
  recordWebhookSignatureFailure,
  recordEventProjectionLag,
  recordQueueBacklog,
  recordQueueRetry,
  recordDeadLetter,
  recordApprovalCallbackResult,
  recordEmailResult,
  recordDbHealth,
  recordAiProviderFailure,
  recordAiTimeout,
  recordAiBudgetExceeded,
  recordIncidentCreated,
  recordIncidentAggregated,
  recordReportGenerationResult,
  recordWorkerHeartbeat,
  resetMetricsForTest,
} from './metrics.js';

export {
  liveCheck,
  readyCheck,
  readyCheckResponse,
  startupCheck,
  type HealthCheckResult,
  type HealthCheckEntry,
  type DependencyCheck,
  type WorkerHeartbeat,
} from './health.js';
