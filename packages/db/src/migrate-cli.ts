import { applyMigrations } from './migrate/runner.js';

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  throw new Error('DATABASE_OWNER_URL is required to run migrations');
}

const result = await applyMigrations(ownerUrl);
console.log(`migrations applied: ${String(result.applied.length)}, skipped: ${String(result.skipped.length)}`);
for (const name of result.applied) console.log(`  applied: ${name}`);
for (const name of result.skipped) console.log(`  skipped: ${name}`);
if (result.applied.length === 0) console.log('schema is up to date');
