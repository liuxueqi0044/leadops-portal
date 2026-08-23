import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from './env.js';

export type DbClient = PostgresJsDatabase;

export interface DatabaseHandle {
  db: DbClient;
  /** Raw postgres.js pool. withTenantContext() operates on this handle. */
  sql: postgres.Sql;
  close(): Promise<void>;
};

export function createDatabase(url: string): DatabaseHandle {
  const sql = postgres(url, { max: 5, connect_timeout: 10 });
  const db = drizzle({ client: sql });
  let closePromise: Promise<void> | null = null;

  const close = async (): Promise<void> => {
    closePromise ??= sql.end();
    await closePromise;
  };

  return { db, sql, close };
}

let _defaultHandle: DatabaseHandle | null = null;

export function getDefaultDatabase(): DatabaseHandle {
  if (_defaultHandle) return _defaultHandle;
  const url = getEnv().DATABASE_URL;
  _defaultHandle = createDatabase(url);
  return _defaultHandle;
}

export async function closeDefaultDatabase(): Promise<void> {
  const handle = _defaultHandle;
  _defaultHandle = null;
  if (handle) await handle.close();
}

export async function healthCheck(db: DbClient): Promise<boolean> {
  try {
    await db.execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
