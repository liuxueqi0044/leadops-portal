import { boolean, index, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './auth.js';

export const ORGANIZATION_ROLES = [
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'client_admin',
  'client_viewer',
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_MEMBER_ROLES = [
  'platform_admin',
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'client_admin',
  'client_viewer',
] as const;

export type OrganizationMemberRole = (typeof ORGANIZATION_MEMBER_ROLES)[number];

export const CLIENT_MEMBER_ROLES = ['client_admin', 'client_viewer'] as const;

export type ClientMemberRole = (typeof CLIENT_MEMBER_ROLES)[number];

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('organizations_slug_unique').on(table.slug)],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organizationId')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 32 }).$type<OrganizationMemberRole>().notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index('organization_members_user_id_idx').on(table.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organizationId')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 32 }).$type<OrganizationRole>().notNull(),
    // sha256 hex of the raw invitation token. The raw token is never stored.
    tokenHash: varchar('tokenHash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).$type<InvitationStatus>().notNull().default('pending'),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    invitedBy: uuid('invitedBy')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_unique').on(table.tokenHash),
    index('invitations_organization_id_idx').on(table.organizationId),
  ],
);

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organizationId')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('clients_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    // Composite unique backing the (clientId, organizationId) foreign keys of
    // client_members and client_assignments to prevent cross-tenant splicing.
    uniqueIndex('clients_id_organization_unique').on(table.id, table.organizationId),
  ],
);

export const clientMembers = pgTable(
  'client_members',
  {
    clientId: uuid('clientId').notNull(),
    organizationId: uuid('organizationId').notNull(),
    userId: uuid('userId').notNull(),
    role: varchar('role', { length: 32 }).$type<ClientMemberRole>().notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId] }),
    index('client_members_user_id_idx').on(table.userId),
  ],
);

export const clientAssignments = pgTable(
  'client_assignments',
  {
    clientId: uuid('clientId').notNull(),
    organizationId: uuid('organizationId').notNull(),
    userId: uuid('userId').notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId] }),
    index('client_assignments_user_id_idx').on(table.userId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organizationId')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actorUserId').references(() => users.id),
    action: varchar('action', { length: 128 }).notNull(),
    resourceType: varchar('resourceType', { length: 64 }).notNull(),
    resourceId: uuid('resourceId'),
    clientId: uuid('clientId'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
  ],
);
