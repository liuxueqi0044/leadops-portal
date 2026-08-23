import { boolean, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

// Better Auth compatible tables. Only the authentication lifecycle is owned by
// Better Auth; authorization comes from the project's tenancy tables.
// Ids are PostgreSQL uuid generated via gen_random_uuid() defaults in the
// forward migration; Better Auth is configured with database.generateId: "uuid".

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerified: boolean('emailVerified').notNull().default(false),
    image: varchar('image', { length: 2048 }),
    // Server-side platform flag. Never returned to browsers; runtime roles are
    // denied UPDATE on this column via column-level REVOKE.
    platformAdmin: boolean('platform_admin').notNull().default(false),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    // Expression index on lower(email) is added in the SQL migration to make
    // email matching case-insensitive at the database level.
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    token: varchar('token', { length: 255 }).notNull(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    ipAddress: varchar('ipAddress', { length: 64 }),
    userAgent: varchar('userAgent', { length: 1024 }),
    // Server-authoritative field: which organization the session is acting in.
    activeOrganizationId: uuid('active_organization_id'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_unique').on(table.token),
    index('sessions_user_id_idx').on(table.userId),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: varchar('accountId', { length: 255 }).notNull(),
    providerId: varchar('providerId', { length: 64 }).notNull(),
    accessToken: varchar('accessToken', { length: 2048 }),
    refreshToken: varchar('refreshToken', { length: 2048 }),
    idToken: varchar('idToken', { length: 4096 }),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
    scope: varchar('scope', { length: 1024 }),
    password: varchar('password', { length: 4096 }),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('accounts_provider_account_unique').on(table.providerId, table.accountId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: varchar('identifier', { length: 320 }).notNull(),
    value: varchar('value', { length: 4096 }).notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);
