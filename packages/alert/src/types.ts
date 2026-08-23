export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertCategory =
  | 'web_5xx_threshold'
  | 'webhook_signature_failure_spike'
  | 'event_projection_lag'
  | 'queue_backlog'
  | 'queue_dead_letter'
  | 'approval_callback_permanent_failure'
  | 'email_permanent_failure'
  | 'db_readiness_failure'
  | 'worker_heartbeat_lost';

export interface AlertBody {
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  value?: number;
  threshold?: number;
  service?: string;
  timestamp: string;
  correlationId?: string;
}

export interface AlertSendRequest {
  body: AlertBody;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface AlertSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  retryable: boolean;
}

export interface AlertProvider {
  send(request: AlertSendRequest): Promise<AlertSendResult>;
}

export type AlertProviderType = 'fake' | 'webhook';
