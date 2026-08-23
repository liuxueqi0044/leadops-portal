import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function defaultMigrationsDir(): string {
  return path.join(import.meta.dirname, '..', '..', 'migrations');
}

/**
 * Applies committed forward-migration SQL files that have not been applied
 * yet, in filename order, each inside its own transaction, and records them
 * in the schema_migrations table. Idempotent and safe to run repeatedly.
 *
 * The connection must be the migration owner (superuser in development) —
 * migrations create roles, tables, RLS policies and grants.
 */
export async function applyMigrations(
  ownerUrl: string,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<MigrationResult> {
  const sql = postgres(ownerUrl, { max: 1, connect_timeout: 10 });
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0) {
      throw new Error(`No migration files found in ${migrationsDir}`);
    }

    for (const file of files) {
      const existing = await sql.unsafe<{ name: string }[]>(
        'SELECT name FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (existing.length > 0) {
        result.skipped.push(file);
        continue;
      }
      const body = await readFile(path.join(migrationsDir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx.unsafe('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      result.applied.push(file);
    }
    return result;
  } finally {
    await sql.end();
  }
}

/** Lists already-applied migration names. */
export async function listAppliedMigrations(ownerUrl: string): Promise<string[]> {
  const sql = postgres(ownerUrl, { max: 1, connect_timeout: 10 });
  try {
    const rows = await sql.unsafe<{ name: string }[]>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    return rows.map((r) => r.name);
  } finally {
    await sql.end();
  }
}
