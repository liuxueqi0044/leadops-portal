import { z } from 'zod';

const UTC_DATETIME = z.string().datetime();
const MAX_DATE_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export const workflowRunDtoSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  workflowId: z.string().uuid(),
  externalRunId: z.string(),
  status: z.enum(['started', 'succeeded', 'failed']),
  startedAt: z.string().nullable(),
  succeededAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  error: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowRunDto = z.infer<typeof workflowRunDtoSchema>;

export const workflowRunsListResponseSchema = z.object({
  items: z.array(workflowRunDtoSchema),
  nextCursor: z.string().nullable(),
});
export type WorkflowRunsListResponse = z.infer<typeof workflowRunsListResponseSchema>;

export const workflowRunsCursorSchema = z.string().min(1).max(512).refine((cursor) => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) return false;
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return false;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    return UTC_DATETIME.safeParse(createdAt).success && z.string().uuid().safeParse(id).success;
  } catch {
    return false;
  }
}, 'invalid workflow runs cursor');

export const workflowRunsListQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  cursor: workflowRunsCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['started', 'succeeded', 'failed']).optional(),
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
