import { z } from 'zod';
import { approvalSnapshotSchema } from './types.js';

export const createApprovalRequestSchema = z
  .object({
    clientId: z.string().uuid(),
    integrationId: z.string().uuid(),
    leadId: z.string().uuid().optional(),
    correlationId: z.string().min(1).max(200).optional(),
    requestVersion: z.string().min(1).max(50).optional(),
    snapshot: approvalSnapshotSchema,
    expiresInSeconds: z.number().int().min(60).max(2592000).default(86400),
    generateToken: z.boolean().default(false),
  })
  .refine((value) => value.leadId !== undefined || value.correlationId !== undefined, {
    message: 'leadId or correlationId is required for idempotency',
  });

export type CreateApprovalRequest = z.infer<typeof createApprovalRequestSchema>;

export const decideApprovalRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(1000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;

export const approvalSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  version: z.number().int(),
  expiresAt: z.string(),
  snapshot: z.record(z.unknown()),
  decidedBy: z.string().nullable().optional(),
  decidedAt: z.string().nullable().optional(),
  decisionReason: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;

export const approvalListItemSchema = approvalSummarySchema.extend({
  clientId: z.string().uuid(),
  leadId: z.string().uuid().nullable(),
  snapshot: approvalSnapshotSchema,
  requestedBy: z.string().nullable(),
  updatedAt: z.string(),
});

export type ApprovalListItem = z.infer<typeof approvalListItemSchema>;

const approvalCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((cursor) => {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return false;
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) return false;
      const separator = decoded.lastIndexOf('|');
      if (separator <= 0) return false;
      return (
        z.string().datetime().safeParse(decoded.slice(0, separator)).success &&
        z
          .string()
          .uuid()
          .safeParse(decoded.slice(separator + 1)).success
      );
    } catch {
      return false;
    }
  }, 'invalid approval cursor');

export const approvalsListQuerySchema = z.object({
  clientId: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).optional(),
  cursor: approvalCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const approvalsListResponseSchema = z.object({
  items: z.array(approvalListItemSchema),
  nextCursor: z.string().nullable(),
});

export type ApprovalsListResponse = z.infer<typeof approvalsListResponseSchema>;

/** Public-facing DTO: only the minimum needed for a decision, no internal data. */
export const publicApprovalDtoSchema = z.object({
  tokenStatus: z.enum(['valid', 'expired', 'already_used', 'revoked']),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
  snapshot: approvalSnapshotSchema,
  expiresAt: z.string().nullable().optional(),
});

export type PublicApprovalDto = z.infer<typeof publicApprovalDtoSchema>;

export const publicDecideRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(1000).optional(),
});

export type PublicDecideRequest = z.infer<typeof publicDecideRequestSchema>;

export const tokenStatusSchema = z.enum([
  'not_found',
  'valid',
  'expired',
  'already_used',
  'revoked',
  'used',
]);

export type TokenStatus = z.infer<typeof tokenStatusSchema>;
