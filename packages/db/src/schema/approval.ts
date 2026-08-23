import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy.js";
import { clients } from "./tenancy.js";
import { integrations } from './events.js';

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId").notNull(),
    clientId: uuid("clientId").notNull(),
    integrationId: uuid('integrationId').notNull(),
    leadId: uuid("leadId"),
    correlationId: text("correlation_id"),
    requestVersion: text("request_version"),
    idempotencyKey: text('idempotency_key').notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    snapshot: jsonb("snapshot").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    version: integer("version").notNull().default(1),
    requestedBy: varchar("requested_by", { length: 100 }),
    decidedBy: varchar("decided_by", { length: 100 }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      columns: [table.clientId, table.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
    foreignKey({
      columns: [table.integrationId, table.organizationId, table.clientId],
      foreignColumns: [
        integrations.id,
        integrations.organizationId,
        integrations.clientId,
      ],
    }),
    uniqueIndex("approvals_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("approvals_id_org_client_unique").on(
      table.id,
      table.organizationId,
      table.clientId,
    ),
    uniqueIndex('approvals_idempotency_unique').on(
      table.organizationId,
      table.clientId,
      table.idempotencyKey,
    ),
  ],
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
