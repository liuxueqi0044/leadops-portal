import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  createDatabase,
  getDefaultDatabase,
  closeDefaultDatabase,
  healthCheck,
  type DatabaseHandle,
} from './client.js';

const bogusUrl = 'postgresql://test:test@localhost:5432/test';
const handles: DatabaseHandle[] = [];

function createTrackedDatabase(url: string): DatabaseHandle {
  const handle = createDatabase(url);
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe('createDatabase', () => {
  it('creates independent handles on each call', () => {
    const h1 = createTrackedDatabase(bogusUrl);
    const h2 = createTrackedDatabase(bogusUrl);
    expect(h1.db).not.toBe(h2.db);
  });
});

describe('getDefaultDatabase', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', bogusUrl);
  });

  afterEach(async () => {
    await closeDefaultDatabase();
    vi.unstubAllEnvs();
  });

  it('returns the same handle on repeated calls', () => {
    const h1 = getDefaultDatabase();
    const h2 = getDefaultDatabase();
    expect(h1).toBe(h2);
  });

  it('creates a fresh handle after closeDefaultDatabase', async () => {
    const h1 = getDefaultDatabase();
    await closeDefaultDatabase();
    const h2 = getDefaultDatabase();
    expect(h1).not.toBe(h2);
  });
});

describe('healthCheck', () => {
  it('returns false when database is unreachable (closed port)', async () => {
    const handle = createTrackedDatabase('postgresql://test:test@localhost:54321/test');
    const result = await healthCheck(handle.db);
    expect(result).toBe(false);
  });

  it('returns false with a different unreachable port', async () => {
    const handle = createTrackedDatabase('postgresql://test:test@localhost:54322/test');
    const result = await healthCheck(handle.db);
    expect(result).toBe(false);
  });
});

describe('handle.close', () => {
  it('is idempotent', async () => {
    const handle = createTrackedDatabase(bogusUrl);
    await handle.close();
    await handle.close();
    // should not throw
  });
});
