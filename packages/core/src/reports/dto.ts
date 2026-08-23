import { z } from 'zod';

const MAX_DATE_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export const GENERATION_VERSION = 1;

export interface WeeklyMetrics {
  leadsReceived: number;
  qualificationRate: number;
  approvalConversion: number;
  appointments: number;
  workflowSuccess: number;
  workflowFailure: number;
  openIncidents: number;
  resolvedIncidents: number;
}

export const weeklyMetricsSchema = z.object({
  leadsReceived: z.number().int().min(0),
  qualificationRate: z.number().min(0).max(1),
  approvalConversion: z.number().min(0).max(1),
  appointments: z.number().int().min(0),
  workflowSuccess: z.number().int().min(0),
  workflowFailure: z.number().int().min(0),
  openIncidents: z.number().int().min(0),
  resolvedIncidents: z.number().int().min(0),
});

export function zeroMetrics(): WeeklyMetrics {
  return {
    leadsReceived: 0,
    qualificationRate: 0,
    approvalConversion: 0,
    appointments: 0,
    workflowSuccess: 0,
    workflowFailure: 0,
    openIncidents: 0,
    resolvedIncidents: 0,
  };
}

export interface WeekInterval {
  periodStart: Date;
  periodEnd: Date;
}

export function calculateWeekInterval(fromDate: Date = new Date()): WeekInterval {
  const d = new Date(fromDate);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff, 0, 0, 0, 0));
  const nextMonday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { periodStart: monday, periodEnd: nextMonday };
}

export function calculatePreviousWeekInterval(fromDate: Date = new Date()): WeekInterval {
  const d = new Date(fromDate);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const thisMonday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff, 0, 0, 0, 0));
  const prevMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { periodStart: prevMonday, periodEnd: thisMonday };
}

export const reportSnapshotDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  generationVersion: z.number().int().positive(),
  metrics: weeklyMetricsSchema,
  correlationId: z.string().nullable(),
  generatedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type ReportSnapshotDto = z.infer<typeof reportSnapshotDtoSchema>;

export const reportsListResponseSchema = z.object({
  items: z.array(reportSnapshotDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ReportsListResponse = z.infer<typeof reportsListResponseSchema>;

const UTC_DATETIME = z.string().datetime();

export const reportsCursorSchema = z.string().min(1).max(512).refine((cursor) => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) return false;
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return false;
    const periodStart = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    return UTC_DATETIME.safeParse(periodStart).success && z.string().uuid().safeParse(id).success;
  } catch {
    return false;
  }
}, 'invalid report cursor');

export const reportsListQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  cursor: reportsCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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
