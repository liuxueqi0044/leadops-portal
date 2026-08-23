import { z } from 'zod';

const MAX_DATE_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_EVENT_TYPES = [
  'opened', 'occurred', 'acknowledged', 'resolved', 'reopened',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export interface IncidentStateMachine {
  canTransition(from: IncidentStatus, to: IncidentStatus): boolean;
  validateTransition(from: IncidentStatus, to: IncidentStatus): void;
}

export function createIncidentStateMachine(): IncidentStateMachine {
  const allowedTransitions: Record<IncidentStatus, IncidentStatus[]> = {
    open: ['acknowledged', 'resolved', 'open'],
    acknowledged: ['resolved', 'open'],
    resolved: ['open'],
  };

  return {
    canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
      return allowedTransitions[from].includes(to);
    },
    validateTransition(from: IncidentStatus, to: IncidentStatus): void {
      if (!this.canTransition(from, to)) {
        throw new Error(
          `Invalid incident status transition: ${from} -> ${to}`,
        );
      }
    },
  };
}

export function normalizeFingerprint(parts: {
  organizationId: string;
  clientId: string;
  workflow?: string;
  category: string;
  errorName: string;
}): string {
  const segments = [
    parts.organizationId,
    parts.clientId,
    parts.workflow ?? 'unknown',
    parts.category,
    parts.errorName,
  ];
  const raw = segments.map((s) => s.replace(/\|/g, '_').toLowerCase()).join('|');
  return raw;
}

export type FingerprintParts = Parameters<typeof normalizeFingerprint>[0];

export const incidentDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  integrationId: z.string().uuid(),
  workflowId: z.string().uuid().nullable(),
  fingerprint: z.string(),
  category: z.string(),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  occurrenceCount: z.number().int().positive(),
  errorSummary: z.string().nullable(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime().nullable(),
  acknowledgedBy: z.string().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  resolvedBy: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IncidentDto = z.infer<typeof incidentDtoSchema>;

export const incidentEventDtoSchema = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  eventType: z.enum(INCIDENT_EVENT_TYPES),
  actor: z.string().nullable(),
  correlationId: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type IncidentEventDto = z.infer<typeof incidentEventDtoSchema>;

export const incidentsListResponseSchema = z.object({
  items: z.array(incidentDtoSchema),
  nextCursor: z.string().nullable(),
});
export type IncidentsListResponse = z.infer<typeof incidentsListResponseSchema>;

export const incidentDetailResponseSchema = incidentDtoSchema.extend({
  events: z.array(incidentEventDtoSchema).optional(),
});
export type IncidentDetailResponse = z.infer<typeof incidentDetailResponseSchema>;

const UTC_DATETIME = z.string().datetime();

export const incidentCursorSchema = z.string().min(1).max(512).refine((cursor) => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) return false;
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return false;
    const lastSeenAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    return UTC_DATETIME.safeParse(lastSeenAt).success && z.string().uuid().safeParse(id).success;
  } catch {
    return false;
  }
}, 'invalid incident cursor');

export const incidentsListQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  cursor: incidentCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  dateFrom: UTC_DATETIME.optional(),
  dateTo: UTC_DATETIME.optional(),
}).refine(
  (v) => {
    if (v.dateFrom && v.dateTo && v.dateFrom > v.dateTo) return false;
    return true;
  },
  { message: 'dateFrom must be <= dateTo' },
).refine(
  (v) => !v.dateFrom || !v.dateTo || new Date(v.dateTo).getTime() - new Date(v.dateFrom).getTime() <= MAX_DATE_RANGE_MS,
  { message: 'date range must not exceed 366 days' },
);

export const acknowledgeIncidentRequestSchema = z.object({
  expectedStatus: z.literal('open'),
});

export const resolveIncidentRequestSchema = z.object({
  expectedStatus: z.enum(['open', 'acknowledged']),
});
