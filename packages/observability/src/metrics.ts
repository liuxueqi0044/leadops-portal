import {
  metrics,
  type Meter,
  type Counter,
  type Histogram,
  type UpDownCounter,
} from '@opentelemetry/api';

let _meter: Meter | null = null;

export function setMeter(meter: Meter): void {
  _meter = meter;
}

function getMeter(): Meter {
  if (!_meter) {
    return metrics.getMeter('leadops-portal');
  }
  return _meter;
}

let httpRequestCounter: Counter | null = null;
let httpRequestDuration: Histogram | null = null;
let webhookSignatureFailureCounter: Counter | null = null;
let eventProjectionLag: Histogram | null = null;
let queueBacklogGauge: UpDownCounter | null = null;
let queueRetryCounter: Counter | null = null;
let deadLetterCounter: Counter | null = null;
let approvalCallbackResultCounter: Counter | null = null;
let emailResultCounter: Counter | null = null;
let dbHealthGauge: UpDownCounter | null = null;
let aiProviderFailureCounter: Counter | null = null;
let aiTimeoutCounter: Counter | null = null;
let aiBudgetExceededCounter: Counter | null = null;
let incidentCreatedCounter: Counter | null = null;
let incidentAggregatedCounter: Counter | null = null;
let reportGenerationResultCounter: Counter | null = null;
let workerHeartbeatGauge: UpDownCounter | null = null;
let lastDbHealthValue = 0;
let lastWorkerHeartbeatValue = 0;

export function recordHttpRequest(route: string, method: string, statusCode: number, durationMs: number): void {
  const meter = getMeter();
  httpRequestCounter ??= meter.createCounter('http_requests_total', {
    description: 'Total HTTP requests',
  });
  httpRequestDuration ??= meter.createHistogram('http_request_duration_ms', {
    description: 'HTTP request duration in milliseconds',
  });

  const attrs = {
    'http.route': route,
    'http.method': method,
    'http.status_code': String(statusCode),
    ...(statusCode >= 500 ? { 'http.error': '5xx' } : {}),
  };

  httpRequestCounter.add(1, attrs);
  httpRequestDuration.record(durationMs, attrs);
}

export function recordWebhookSignatureFailure(): void {
  const meter = getMeter();
  webhookSignatureFailureCounter ??= meter.createCounter('webhook_signature_failures_total', {
    description: 'Total webhook signature verification failures',
  });
  webhookSignatureFailureCounter.add(1);
}

export function recordEventProjectionLag(lagMs: number, eventType: string): void {
  const meter = getMeter();
  eventProjectionLag ??= meter.createHistogram('event_projection_lag_ms', {
    description: 'Event projection lag in milliseconds',
  });
  eventProjectionLag.record(lagMs, { 'event.type': eventType });
}

export function recordQueueBacklog(queueName: string, size: number): void {
  const meter = getMeter();
  queueBacklogGauge ??= meter.createUpDownCounter('queue_backlog', {
    description: 'Current queue backlog size',
  });
  queueBacklogGauge.add(size, { 'queue.name': queueName });
}

export function recordQueueRetry(queueName: string): void {
  const meter = getMeter();
  queueRetryCounter ??= meter.createCounter('queue_retries_total', {
    description: 'Total queue retries',
  });
  queueRetryCounter.add(1, { 'queue.name': queueName });
}

export function recordDeadLetter(queueName: string, jobName: string): void {
  const meter = getMeter();
  deadLetterCounter ??= meter.createCounter('queue_dead_letters_total', {
    description: 'Total dead letter jobs',
  });
  deadLetterCounter.add(1, { 'queue.name': queueName, 'job.name': jobName });
}

export function recordApprovalCallbackResult(result: 'success' | 'failure'): void {
  const meter = getMeter();
  approvalCallbackResultCounter ??= meter.createCounter('approval_callback_results_total', {
    description: 'Total approval callback results',
  });
  approvalCallbackResultCounter.add(1, { result });
}

export function recordEmailResult(result: 'sent' | 'failed' | 'permanent_failure'): void {
  const meter = getMeter();
  emailResultCounter ??= meter.createCounter('email_results_total', {
    description: 'Total email send results',
  });
  emailResultCounter.add(1, { result });
}

export function recordDbHealth(status: 'healthy' | 'unhealthy' | 'saturated'): void {
  const meter = getMeter();
  dbHealthGauge ??= meter.createUpDownCounter('db_health_status', {
    description: 'Database health status indicator',
  });
  const nextValue = status === 'healthy' ? 1 : status === 'saturated' ? -1 : 0;
  dbHealthGauge.add(nextValue - lastDbHealthValue);
  lastDbHealthValue = nextValue;
}

export function recordAiProviderFailure(provider: string, reason: string): void {
  const meter = getMeter();
  aiProviderFailureCounter ??= meter.createCounter('ai_provider_failures_total', {
    description: 'Total AI provider failures',
  });
  aiProviderFailureCounter.add(1, { provider, reason });
}

export function recordAiTimeout(provider: string): void {
  const meter = getMeter();
  aiTimeoutCounter ??= meter.createCounter('ai_timeouts_total', {
    description: 'Total AI provider timeouts',
  });
  aiTimeoutCounter.add(1, { provider });
}

export function recordAiBudgetExceeded(provider: string): void {
  const meter = getMeter();
  aiBudgetExceededCounter ??= meter.createCounter('ai_budget_exceeded_total', {
    description: 'Total AI budget exceeded events',
  });
  aiBudgetExceededCounter.add(1, { provider });
}

export function recordIncidentCreated(): void {
  const meter = getMeter();
  incidentCreatedCounter ??= meter.createCounter('incidents_created_total', {
    description: 'Total incidents created',
  });
  incidentCreatedCounter.add(1);
}

export function recordIncidentAggregated(): void {
  const meter = getMeter();
  incidentAggregatedCounter ??= meter.createCounter('incidents_aggregated_total', {
    description: 'Total incident occurrence aggregations',
  });
  incidentAggregatedCounter.add(1);
}

export function recordReportGenerationResult(result: 'success' | 'failure'): void {
  const meter = getMeter();
  reportGenerationResultCounter ??= meter.createCounter('report_generation_results_total', {
    description: 'Total weekly report generation results',
  });
  reportGenerationResultCounter.add(1, { result });
}

export function recordWorkerHeartbeat(status: 'alive' | 'lost'): void {
  const meter = getMeter();
  workerHeartbeatGauge ??= meter.createUpDownCounter('worker_heartbeat_status', {
    description: 'Worker heartbeat status indicator',
  });
  const nextValue = status === 'alive' ? 1 : 0;
  workerHeartbeatGauge.add(nextValue - lastWorkerHeartbeatValue);
  lastWorkerHeartbeatValue = nextValue;
}

export function resetMetricsForTest(): void {
  httpRequestCounter = null;
  httpRequestDuration = null;
  webhookSignatureFailureCounter = null;
  eventProjectionLag = null;
  queueBacklogGauge = null;
  queueRetryCounter = null;
  deadLetterCounter = null;
  approvalCallbackResultCounter = null;
  emailResultCounter = null;
  dbHealthGauge = null;
  aiProviderFailureCounter = null;
  aiTimeoutCounter = null;
  aiBudgetExceededCounter = null;
  incidentCreatedCounter = null;
  incidentAggregatedCounter = null;
  reportGenerationResultCounter = null;
  workerHeartbeatGauge = null;
  lastDbHealthValue = 0;
  lastWorkerHeartbeatValue = 0;
}
