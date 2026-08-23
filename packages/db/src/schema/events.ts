import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { clients, organizations } from "./tenancy.js";

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("clientId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    callbackUrl: text('callback_url'),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.clientId, table.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
    uniqueIndex("integrations_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("integrations_id_org_client_unique").on(
      table.id,
      table.organizationId,
      table.clientId,
    ),
    uniqueIndex("integrations_org_client_name_unique").on(
      table.organizationId,
      table.clientId,
      table.name,
    ),
  ],
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;

export const integrationSecrets = pgTable(
  "integration_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationId: uuid("integrationId").notNull(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    encryptedSecret: text("encrypted_secret").notNull(),
    activeFrom: timestamp("activeFrom", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.integrationId, table.organizationId],
      foreignColumns: [integrations.id, integrations.organizationId],
    }),
    uniqueIndex("integration_secrets_integration_version_unique").on(
      table.integrationId,
      table.version,
    ),
  ],
);

export type IntegrationSecret = typeof integrationSecrets.$inferSelect;
export type NewIntegrationSecret = typeof integrationSecrets.$inferInsert;

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integrationId").notNull(),
    clientId: uuid("clientId").notNull(),
    externalId: varchar("externalId", { length: 200 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.integrationId, table.organizationId, table.clientId],
      foreignColumns: [integrations.id, integrations.organizationId, integrations.clientId],
    }),
    uniqueIndex("workflows_id_org_client_unique").on(
      table.id,
      table.organizationId,
      table.clientId,
    ),
    uniqueIndex("workflows_integration_external_unique").on(
      table.integrationId,
      table.externalId,
    ),
  ],
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("clientId").notNull(),
    workflowId: uuid("workflowId").notNull(),
    externalRunId: varchar("externalRunId", { length: 200 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("started"),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    succeededAt: timestamp("succeededAt", { withTimezone: true }),
    failedAt: timestamp("failedAt", { withTimezone: true }),
    error: jsonb("error"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workflowId, table.organizationId, table.clientId],
      foreignColumns: [workflows.id, workflows.organizationId, workflows.clientId],
    }),
    uniqueIndex("workflow_runs_workflow_external_unique").on(
      table.workflowId,
      table.externalRunId,
    ),
  ],
);

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

export const businessEvents = pgTable(
  "business_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationId: uuid("integrationId").notNull(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("clientId").notNull(),
    webhookId: varchar("webhookId", { length: 200 }).notNull(),
    eventType: varchar("eventType", { length: 200 }).notNull(),
    rawJson: jsonb("raw_json").notNull(),
    bodyHash: varchar("body_hash", { length: 128 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("received"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("receivedAt", { withTimezone: true }).notNull().defaultNow(),
    projectedAt: timestamp("projectedAt", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.integrationId, table.organizationId, table.clientId],
      foreignColumns: [integrations.id, integrations.organizationId, integrations.clientId],
    }),
    uniqueIndex("business_events_integration_webhook_unique").on(
      table.integrationId,
      table.webhookId,
    ),
    index("business_events_org_received_idx").on(
      table.organizationId,
      table.receivedAt,
    ),
  ],
);

export type BusinessEvent = typeof businessEvents.$inferSelect;
export type NewBusinessEvent = typeof businessEvents.$inferInsert;

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integrationId").notNull(),
    clientId: uuid("clientId").notNull(),
    aggregateType: varchar("aggregate_type", { length: 100 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 200 }).notNull(),
    messageType: varchar("message_type", { length: 200 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    lockedAt: timestamp("lockedAt", { withTimezone: true }),
    lockedBy: varchar("lockedBy", { length: 200 }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    nextAttemptAt: timestamp("nextAttemptAt", { withTimezone: true }).defaultNow(),
    lastError: text("last_error"),
    deliveredAt: timestamp("deliveredAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.integrationId, table.organizationId, table.clientId],
      foreignColumns: [integrations.id, integrations.organizationId, integrations.clientId],
    }),
    index("outbox_status_attempt_idx").on(table.status, table.nextAttemptAt),
  ],
);

export type OutboxMessage = typeof outbox.$inferSelect;
export type NewOutboxMessage = typeof outbox.$inferInsert;
