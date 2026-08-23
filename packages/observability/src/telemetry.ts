import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { metrics, type Meter } from '@opentelemetry/api';
import { setMeter } from './metrics.js';
import type { Logger } from 'pino';

export type TelemetryEnvironment = 'local' | 'test' | 'staging' | 'production';

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  environment: TelemetryEnvironment;
  otlpEndpoint?: string;
  enabled?: boolean;
  logger?: Logger;
}

let sdkInstance: NodeSDK | null = null;
let telemetryEnabled = false;
let configSnapshot: TelemetryConfig | null = null;

export function isTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

export function getTelemetryConfig(): TelemetryConfig | null {
  return configSnapshot;
}

export async function initTelemetry(config: TelemetryConfig): Promise<void> {
  configSnapshot = { ...config };

  const shouldEnable = config.enabled ?? (config.environment === 'production' || config.environment === 'staging');
  const isDevTest = config.environment === 'test' || config.environment === 'local';

  if (!shouldEnable || isDevTest) {
    telemetryEnabled = false;
    config.logger?.info({ event: 'telemetry.disabled', reason: 'environment' }, 'Telemetry disabled');
    return;
  }

  if (!config.otlpEndpoint) {
    if (config.environment === 'production' || config.environment === 'staging') {
      config.logger?.fatal({ event: 'telemetry.misconfigured', reason: 'missing_otlp_endpoint' }, 'Telemetry enabled but OTLP endpoint is missing');
      throw new Error('Telemetry enabled in production but OTLP endpoint is not configured');
    }
    telemetryEnabled = false;
    config.logger?.warn({ event: 'telemetry.disabled', reason: 'no_endpoint' }, 'Telemetry disabled due to missing OTLP endpoint');
    return;
  }

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
      'deployment.environment': config.environment,
    });

    const traceExporter = new OTLPTraceExporter({
      url: `${config.otlpEndpoint}/v1/traces`,
    });

    const metricExporter = new OTLPMetricExporter({
      url: `${config.otlpEndpoint}/v1/metrics`,
    });

    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 30000,
    });

    const spanProcessor = new BatchSpanProcessor(traceExporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
    });

    const sdk = new NodeSDK({
      resource,
      spanProcessors: [spanProcessor],
      metricReader,
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (request) => {
            const url = request.url ?? '';
            return (
              url.includes('/api/health/live') ||
              url.includes('/api/health/ready')
            );
          },
        }),
        new PgInstrumentation({
          enhancedDatabaseReporting: false,
        }),
      ],
      autoDetectResources: false,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression
    await sdk.start();
    sdkInstance = sdk;
    telemetryEnabled = true;

    const meter = metrics.getMeter(config.serviceName, config.serviceVersion ?? '0.0.0');
    setMeter(meter);

    config.logger?.info({ event: 'telemetry.started', otlpEndpoint: config.otlpEndpoint, serviceName: config.serviceName }, 'OpenTelemetry SDK started');
  } catch (error) {
    if (config.environment === 'production' || config.environment === 'staging') {
      config.logger?.fatal({ event: 'telemetry.init_failure', error: error instanceof Error ? error.message : String(error) }, 'Failed to initialize telemetry in production');
      throw error;
    }
    telemetryEnabled = false;
    config.logger?.warn({ event: 'telemetry.init_failure', error: error instanceof Error ? error.message : String(error) }, 'Telemetry initialization failed, continuing without telemetry');
  }
}

export async function shutdownTelemetry(timeoutMs?: number): Promise<void> {
  if (!sdkInstance) return;

  try {
    if (timeoutMs) {
      await Promise.race([
        sdkInstance.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } else {
      await sdkInstance.shutdown();
    }
  } catch {
    // Shutdown failures are not fatal
  } finally {
    sdkInstance = null;
    telemetryEnabled = false;
  }
}

export type { Meter };
export { metrics } from '@opentelemetry/api';
export { trace, type Tracer, type Span, SpanStatusCode } from '@opentelemetry/api';
