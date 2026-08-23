import postgres from 'postgres';

import { applyMigrations } from '../migrate/runner.js';

const RUNTIME_ROLES = new Set(['leadops_runtime', 'leadops_runtime_test']);

interface PgRoleRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

interface DbNameRow {
  name: string;
}

function databaseNameFromUrl(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Cannot derive a valid database name from URL path '${parsed.pathname}'`);
  }
  return name;
}

function replaceDatabaseName(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Test database bootstrap, shared by db/integration/e2e vitest projects.
 *
 * 1. Fails loudly when DATABASE_URL or DATABASE_OWNER_URL are missing.
 * 2. Creates the test database (owner connection) if it does not exist.
 * 3. Applies all migrations as the owner (tables, roles, grants, RLS).
 * 4. Refuses to run when DATABASE_URL connects as anything other than a
 *    runtime role (never as the owner/superuser — RLS tests would be void).
 * 5. Verifies the runtime test role can connect to the test database.
 */
export default async function globalSetup(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.DATABASE_OWNER_URL;

  if (!appUrl || !ownerUrl) {
    throw new Error(
      'DATABASE_URL and DATABASE_OWNER_URL are both required for database tests.\n' +
        'Example:\n' +
        '  DATABASE_URL=postgresql://leadops_runtime_test:leadops_runtime_test_dev@localhost:5432/leadops_test\n' +
        '  DATABASE_OWNER_URL=postgresql://leadops:leadops_dev@localhost:5432/leadops\n' +
        'Start PostgreSQL with `docker compose up -d --wait postgres` first.',
    );
  }

  const testDbName = databaseNameFromUrl(appUrl);
  const ownerDbName = databaseNameFromUrl(ownerUrl);

  // 2: create the test database if needed.
  if (testDbName !== ownerDbName) {
    const maintenance = postgres(ownerUrl, { max: 1, connect_timeout: 10 });
    try {
      const existing = await maintenance.unsafe<DbNameRow[]>(
        'SELECT datname AS name FROM pg_database WHERE datname = $1',
        [testDbName],
      );
      if (existing.length === 0) {
        await maintenance.unsafe(`CREATE DATABASE ${testDbName} OWNER ${ownerDbName}`);
      }
    } finally {
      await maintenance.end();
    }
  }

  // 3: apply migrations as the owner.
  const migrationUrl = testDbName === ownerDbName ? ownerUrl : replaceDatabaseName(ownerUrl, testDbName);
  const result = await applyMigrations(migrationUrl);
  console.log(`[test-setup] migrations applied: ${String(result.applied.length)}, skipped: ${String(result.skipped.length)}`);
  for (const name of result.applied) console.log(`[test-setup]   applied: ${name}`);
  for (const name of result.skipped) console.log(`[test-setup]   skipped: ${name}`);

  // pg-boss owns its schema outside the application migration set. Clear the
  // test-only queue before every suite so a previously interrupted worker
  // cannot replay stale jobs against freshly truncated fixture data.
  const queueOwner = postgres(migrationUrl, { max: 1, connect_timeout: 10 });
  try {
    await queueOwner.unsafe('DROP SCHEMA IF EXISTS "pgboss_test" CASCADE');
  } finally {
    await queueOwner.end();
  }

  // 4: verify the app connection is a runtime role.
  const appSql = postgres(appUrl, { max: 1, connect_timeout: 10 });
  try {
    const role = await appSql.unsafe<{ current_user: string }[]>('SELECT current_user');
    const currentUser = role[0]?.current_user;
    if (!currentUser || !RUNTIME_ROLES.has(currentUser)) {
      throw new Error(
        `DATABASE_URL must connect as a runtime role (leadops_runtime / leadops_runtime_test), ` +
          `got '${currentUser ?? 'unknown'}'. Running tests as the owner/superuser would make RLS tests meaningless.`,
      );
    }
    const props = await appSql.unsafe<PgRoleRow[]>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const p = props[0];
    if (!p || p.rolsuper) {
      throw new Error(`Runtime role ${currentUser} must not be superuser`);
    }
    if (p.rolbypassrls) {
      throw new Error(`Runtime role ${currentUser} must not have BYPASSRLS`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('DATABASE_URL must')) throw err;
    throw new Error(
      `DATABASE_URL (${appUrl}) is not reachable with the given credentials: ${String(err)}`,
      { cause: err },
    );
  } finally {
    await appSql.end();
  }

  // 5: the runtime test role can actually connect.
  const verifySql = postgres(appUrl, { max: 1, connect_timeout: 10 });
  try {
    await verifySql.unsafe('SELECT 1');
  } catch (err) {
    throw new Error(
      `Runtime role cannot connect to test database ${testDbName}: ${String(err)}`,
      { cause: err },
    );
  } finally {
    await verifySql.end();
  }
}
