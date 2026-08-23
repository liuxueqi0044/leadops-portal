import {
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { clients, organizations } from "./tenancy.js";

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("clientId").notNull(),
    source: varchar("source", { length: 100 }).notNull(),
    externalId: varchar("externalId", { length: 300 }),
    dedupeKey: varchar("dedupeKey", { length: 500 }).notNull(),
    dedupeVersion: integer("dedupeVersion").notNull().default(1),
    status: varchar("status", { length: 20 }).notNull().default("received"),
    contactName: varchar("contactName", { length: 300 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 100 }),
    company: varchar("company", { length: 300 }),
    message: text("message"),
    score: integer("score"),
    qualificationDecision: varchar("qualificationDecision", { length: 20 }),
    qualificationSummary: varchar("qualificationSummary", { length: 500 }),
    qualificationConfidence: doublePrecision("qualificationConfidence"),
    suggestedNextAction: varchar("suggestedNextAction", { length: 50 }),
    metadata: jsonb("metadata"),
    receivedAt: timestamp("receivedAt", { withTimezone: true }),
    qualifiedAt: timestamp("qualifiedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.clientId, table.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
    uniqueIndex("leads_client_source_external_id_unique").on(
      table.clientId,
      table.source,
      table.externalId,
    ),
    uniqueIndex("leads_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("leads_id_org_client_unique").on(
      table.id,
      table.organizationId,
      table.clientId,
    ),
    index("leads_dedupe_key_idx").on(table.clientId, table.dedupeKey),
    index("leads_status_idx").on(table.organizationId, table.clientId, table.status),
    index("leads_org_received_idx").on(table.organizationId, table.receivedAt.desc()),
  ],
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

export const leadStatusHistory = pgTable(
  "lead_status_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leadId: uuid("leadId").notNull(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("clientId").notNull(),
    previousStatus: varchar("previousStatus", { length: 20 }),
    newStatus: varchar("newStatus", { length: 20 }).notNull(),
    command: varchar("command", { length: 50 }).notNull(),
    performedBy: varchar("performedBy", { length: 50 }).notNull().default("system"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.leadId, table.organizationId, table.clientId],
      foreignColumns: [leads.id, leads.organizationId, leads.clientId],
    }),
    index("lead_status_history_lead_idx").on(table.leadId, table.createdAt),
  ],
);

export type LeadStatusHistory = typeof leadStatusHistory.$inferSelect;
export type NewLeadStatusHistory = typeof leadStatusHistory.$inferInsert;

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("clientId").notNull(),
    leadId: uuid("leadId").notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    model: varchar("model", { length: 200 }).notNull(),
    promptVersion: varchar("promptVersion", { length: 50 }).notNull(),
    inputHash: varchar("inputHash", { length: 200 }).notNull(),
    result: jsonb("result"),
    tokens: jsonb("tokens"),
    cost: jsonb("cost"),
    latencyMs: integer("latencyMs").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    errorClassification: varchar("errorClassification", { length: 100 }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.leadId, table.organizationId, table.clientId],
      foreignColumns: [leads.id, leads.organizationId, leads.clientId],
    }),
    index("ai_runs_lead_idx").on(table.leadId),
  ],
);

export type AiRun = typeof aiRuns.$inferSelect;
export type NewAiRun = typeof aiRuns.$inferInsert;
