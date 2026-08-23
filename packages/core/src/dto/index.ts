import { z } from 'zod';

/**
 * Stable API DTOs. Framework-free (zod only) so both the API routes
 * (server-side validation) and the frontend (type consumption) can rely on
 * them without importing server-only code. No Drizzle rows, no Better Auth
 * internals, no session tokens, no platform_admin flag, no foreign tenant ids.
 */

export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const organizationDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
});
export type OrganizationDto = z.infer<typeof organizationDtoSchema>;

export const clientSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClientSummaryDto = z.infer<typeof clientSummaryDtoSchema>;

export const meResponseSchema = z.object({
  user: userDtoSchema,
  organization: organizationDtoSchema,
  clients: z.array(clientSummaryDtoSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const clientsListResponseSchema = z.object({
  items: z.array(clientSummaryDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ClientsListResponse = z.infer<typeof clientsListResponseSchema>;

export const clientDetailResponseSchema = clientSummaryDtoSchema;
export type ClientDetailResponse = z.infer<typeof clientDetailResponseSchema>;

export const createClientRequestSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200, 'name is too long'),
});
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

export const updateClientRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'at least one of name or status must be provided',
  });
export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;

export const elevationRequestSchema = z.object({
  targetOrganizationId: z.string().uuid('targetOrganizationId must be a uuid'),
  reason: z.string().trim().min(3, 'reason is required (min 3 characters)').max(200),
});
export type ElevationRequest = z.infer<typeof elevationRequestSchema>;

export const elevationResponseSchema = z.object({
  organizationId: z.string().uuid(),
  role: z.literal('platform_admin'),
  elevated: z.literal(true),
});
export type ElevationResponse = z.infer<typeof elevationResponseSchema>;

export const switchOrganizationRequestSchema = z.object({
  organizationId: z.string().uuid('organizationId must be a uuid'),
});
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const clientsListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// Phase 4: Lead and dashboard DTOs

export const leadSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  externalId: z.string().nullable(),
  status: z.string(),
  contactName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  aiSuggestion: z.object({
    decision: z.enum(["qualified", "needs_review", "disqualified"]).nullable(),
    summary: z.string().nullable(),
    suggestedNextAction: z.string().nullable(),
  }).nullable(),
  confirmedStatus: z.string(),
  executedBusinessAction: z.string().nullable(),
  receivedAt: z.string().nullable(),
  qualifiedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LeadSummaryDto = z.infer<typeof leadSummaryDtoSchema>;

export const leadDetailDtoSchema = leadSummaryDtoSchema.extend({
  message: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  metadata: z.record(z.unknown()).nullable(),
  statusHistory: z.array(z.object({
    previousStatus: z.string().nullable(),
    newStatus: z.string(),
    command: z.string(),
    performedBy: z.string(),
    createdAt: z.string(),
  })).optional(),
});
export type LeadDetailDto = z.infer<typeof leadDetailDtoSchema>;

export const leadsListResponseSchema = z.object({
  items: z.array(leadSummaryDtoSchema),
  nextCursor: z.string().nullable(),
});
export type LeadsListResponse = z.infer<typeof leadsListResponseSchema>;

const STATUS_ENUM = z.enum(["received", "qualified", "needs_review", "approved", "rejected", "converted", "archived"]);
const UTC_DATETIME = z.string().datetime();

export const leadCursorSchema = z.string().min(1).max(512).refine((cursor) => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return false;
    const separator = decoded.lastIndexOf("|");
    if (separator <= 0) return false;
    const receivedAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    return UTC_DATETIME.safeParse(receivedAt).success && z.string().uuid().safeParse(id).success;
  } catch {
    return false;
  }
}, "invalid cursor");

export const leadsListQuerySchema = z.object({
  cursor: leadCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: STATUS_ENUM.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().trim().min(1).max(200).optional(),
  dateFrom: UTC_DATETIME.optional(),
  dateTo: UTC_DATETIME.optional(),
}).refine(
  (v) => {
    if (v.minScore !== undefined && v.maxScore !== undefined && v.minScore > v.maxScore) return false;
    return true;
  },
  { message: "minScore must be <= maxScore" },
).refine(
  (v) => {
    if (v.dateFrom && v.dateTo && v.dateFrom > v.dateTo) return false;
    return true;
  },
  { message: "dateFrom must be <= dateTo" },
);

export const dashboardResponseSchema = z.object({
  totalReceived: z.number().int(),
  totalQualified: z.number().int(),
  totalNeedsReview: z.number().int(),
  totalApproved: z.number().int(),
  totalRejected: z.number().int(),
  totalConverted: z.number().int(),
  totalArchived: z.number().int(),
  qualificationRate: z.number().nullable(),
  avgScore: z.number().nullable(),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const dashboardQuerySchema = z.object({
  dateFrom: UTC_DATETIME.optional(),
  dateTo: UTC_DATETIME.optional(),
}).refine(
  (value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo,
  { message: "dateFrom must be <= dateTo" },
);

export const operationsDashboardResponseSchema = z.object({
  leadsReceived: z.number().int().min(0),
  qualificationRate: z.number().min(0).max(1),
  approvalConversion: z.number().min(0).max(1),
  appointments: z.number().int().min(0),
  workflowSuccess: z.number().int().min(0),
  workflowFailure: z.number().int().min(0),
  openIncidents: z.number().int().min(0),
  resolvedIncidents: z.number().int().min(0),
  totalLeads: z.number().int().min(0),
  totalQualified: z.number().int().min(0),
  totalApproved: z.number().int().min(0),
  totalRejected: z.number().int().min(0),
  avgScore: z.number().nullable(),
});
export type OperationsDashboardResponse = z.infer<typeof operationsDashboardResponseSchema>;

export const operationsDashboardQuerySchema = z.object({
  clientId: z.string().uuid().optional(),
  dateFrom: UTC_DATETIME.optional(),
  dateTo: UTC_DATETIME.optional(),
}).refine(
  (value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo,
  { message: "dateFrom must be <= dateTo" },
).refine(
  (value) => !value.dateFrom || !value.dateTo || new Date(value.dateTo).getTime() - new Date(value.dateFrom).getTime() <= 366 * 24 * 60 * 60 * 1000,
  { message: "date range must not exceed 366 days" },
);
