import { applyMigrations } from '../src/migrate/runner.js';

const ownerUrl = process.env.DATABASE_OWNER_URL;

if (!ownerUrl) {
  console.error(
    'DATABASE_OWNER_URL is required to run migrations. ' +
      'Example: DATABASE_OWNER_URL=postgresql://leadops:leadops_dev@localhost:5432/leadops pnpm db:migrate',
  );
  process.exit(1);
}

const result = await applyMigrations(ownerUrl);
  console.log(`migrations applied: ${String(result.applied.length)}, skipped: ${String(result.skipped.length)}`);
for (const name of result.applied) console.log(`  applied: ${name}`);
for (const name of result.skipped) console.log(`  skipped: ${name}`);
if (result.applied.length === 0) {
  console.log('schema is up to date');
}
