import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  createDatabase,
  healthCheck,
  type DatabaseHandle,
} from './client.js';

const dbUrl = process.env.DATABASE_URL;
const handles: DatabaseHandle[] = [];

function createTrackedDatabase(url: string): DatabaseHandle {
  const handle = createDatabase(url);
  handles.push(handle);
  return handle;
}

describe('healthCheck with database', () => {
  beforeAll(() => {
    if (!dbUrl) {
      throw new Error(
        'DATABASE_URL is required for pnpm test:db. Start PostgreSQL with `docker compose up -d --wait postgres` and set DATABASE_URL before retrying.',
      );
    }
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
  });

  it('returns true when PostgreSQL is available', async () => {
    if (!dbUrl) {
      throw new Error('DATABASE_URL is required');
    }
    const handle = createTrackedDatabase(dbUrl);
    const ok = await healthCheck(handle.db);
    expect(ok).toBe(true);
  });

  it('returns false with invalid credentials', async () => {
    const handle = createTrackedDatabase('postgresql://bad:wrong@localhost:5432/leadops');
    const result = await healthCheck(handle.db);
    expect(result).toBe(false);
  });

  it('returns false when database is unreachable', async () => {
    const handle = createTrackedDatabase('postgresql://test:test@192.0.2.1:5432/test');
    const result = await healthCheck(handle.db);
    expect(result).toBe(false);
  }, 30_000);
});
