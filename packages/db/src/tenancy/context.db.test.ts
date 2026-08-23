import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixtureHandle, type FixtureHandle, resetSchema } from '../test/fixtures.js';
import { withTenantContext } from './context.js';

let fixture: FixtureHandle;

beforeAll(async () => {
  fixture = createFixtureHandle();
  await resetSchema(fixture);
});

afterAll(async () => {
  await fixture.close();
});

describe('withTenantContext', () => {
  it('commits the callback work on success and sets transaction-local context', async () => {
    await fixture.owner.unsafe(
      `INSERT INTO users (id, name, email) VALUES
       ('aaaa1111-0000-0000-0000-000000000001', 'U1', 'u1@t.dev')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO organizations (id, name, slug) VALUES
       ('aaaa1111-0000-0000-0000-000000000002', 'Org', 'ctx-org')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO organization_members ("organizationId", "userId", role)
       VALUES ('aaaa1111-0000-0000-0000-000000000002', 'aaaa1111-0000-0000-0000-000000000001', 'agency_owner')`,
    );

    await withTenantContext(
      fixture.app,
      {
        userId: 'aaaa1111-0000-0000-0000-000000000001',
        organizationId: 'aaaa1111-0000-0000-0000-000000000002',
        role: 'agency_owner',
      },
      async (tx) => {
        await tx.unsafe(
          `INSERT INTO clients (id, "organizationId", name) VALUES
           ('aaaa1111-0000-0000-0000-000000000003', 'aaaa1111-0000-0000-0000-000000000002', 'Ctx Client')`,
        );
        // Context is visible inside the transaction.
        const rows = await tx.unsafe<{ role: string }[]>(
          `SELECT current_setting('app.role', true) AS role`,
        );
        expect(rows[0]?.role).toBe('agency_owner');
      },
    );

    const client = await fixture.owner.unsafe<{ name: string }[]>(
      `SELECT name FROM clients WHERE id = 'aaaa1111-0000-0000-0000-000000000003'`,
    );
    expect(client[0]?.name).toBe('Ctx Client');
  });

  it('rolls back everything (including context writes) when the callback throws', async () => {
    const before = await fixture.owner.unsafe<{ n: string }[]>(
      `SELECT count(*) AS n FROM clients WHERE "organizationId" = 'aaaa1111-0000-0000-0000-000000000002'`,
    );

    await expect(
      withTenantContext(
        fixture.app,
        {
          userId: 'aaaa1111-0000-0000-0000-000000000001',
          organizationId: 'aaaa1111-0000-0000-0000-000000000002',
          role: 'agency_owner',
        },
        async (tx) => {
          await tx.unsafe(
            `INSERT INTO clients ("organizationId", name) VALUES ('aaaa1111-0000-0000-0000-000000000002', 'Rollback')`,
          );
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    const after = await fixture.owner.unsafe<{ n: string }[]>(
      `SELECT count(*) AS n FROM clients WHERE "organizationId" = 'aaaa1111-0000-0000-0000-000000000002'`,
    );
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
  });

  it('never leaves context on the pooled connection after the transaction', async () => {
    await withTenantContext(
      fixture.app,
      {
        userId: 'aaaa1111-0000-0000-0000-000000000001',
        organizationId: 'aaaa1111-0000-0000-0000-000000000002',
        role: 'agency_owner',
      },
      async (tx) => {
        await tx.unsafe('SELECT 1');
      },
    );

    // On the same pool (possibly a reused connection), no usable app.*
    // setting may remain. PostgreSQL restores transaction-local custom GUCs
    // to an empty string (''), which the RLS helpers treat as unset.
    const rows = await fixture.app.unsafe<{ v: string | null }[]>(
      `SELECT current_setting('app.organization_id', true) AS v`,
    );
    expect(['', null]).toContain(rows[0]?.v);

    const roleRows = await fixture.app.unsafe<{ v: string | null }[]>(
      `SELECT current_setting('app.role', true) AS v`,
    );
    expect(['', null]).toContain(roleRows[0]?.v);

    // An empty restored value must not grant access: verify a follow-up
    // SELECT on tenant data returns zero rows without an explicit context.
    const leaked = await fixture.app.unsafe<{ n: string }[]>(
      `SELECT count(*) AS n FROM clients`,
    );
    expect(Number(leaked[0]?.n)).toBe(0);
  });

  it('does not leak one tenant context into a subsequent transaction', async () => {
    await fixture.owner.unsafe(
      `INSERT INTO organizations (id, name, slug) VALUES
       ('bbbb1111-0000-0000-0000-000000000002', 'Org B2', 'ctx-org-b2'),
       ('bbbb1111-0000-0000-0000-000000000003', 'Org B3', 'ctx-org-b3')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO organization_members ("organizationId", "userId", role) VALUES
       ('bbbb1111-0000-0000-0000-000000000002', 'aaaa1111-0000-0000-0000-000000000001', 'agency_owner'),
       ('bbbb1111-0000-0000-0000-000000000003', 'aaaa1111-0000-0000-0000-000000000001', 'agency_owner')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO clients (id, "organizationId", name) VALUES
       ('bbbb1111-0000-0000-0000-000000000004', 'bbbb1111-0000-0000-0000-000000000002', 'B2 Client'),
       ('bbbb1111-0000-0000-0000-000000000005', 'bbbb1111-0000-0000-0000-000000000003', 'B3 Client')`,
    );

    const userId = 'aaaa1111-0000-0000-0000-000000000001';
    const names: string[] = [];

    await withTenantContext(
      fixture.app,
      { userId, organizationId: 'bbbb1111-0000-0000-0000-000000000002', role: 'agency_owner' },
      async (tx) => {
        const rows = await tx.unsafe<{ name: string }[]>(`SELECT name FROM clients`);
        names.push(...rows.map((r) => r.name));
      },
    );

    await withTenantContext(
      fixture.app,
      { userId, organizationId: 'bbbb1111-0000-0000-0000-000000000003', role: 'agency_owner' },
      async (tx) => {
        const rows = await tx.unsafe<{ name: string }[]>(`SELECT name FROM clients`);
        names.push(...rows.map((r) => r.name));
      },
    );

    expect(names).toEqual(['B2 Client', 'B3 Client']);
  });

  it('denies tenant data when no context is set (missing context defaults to deny)', async () => {
    await resetSchema(fixture);
    await fixture.owner.unsafe(
      `INSERT INTO users (id, name, email) VALUES
       ('cccc1111-0000-0000-0000-000000000001', 'U2', 'u2@t.dev')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO organizations (id, name, slug) VALUES
       ('cccc1111-0000-0000-0000-000000000002', 'Org C', 'ctx-org-c')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO organization_members ("organizationId", "userId", role)
       VALUES ('cccc1111-0000-0000-0000-000000000002', 'cccc1111-0000-0000-0000-000000000001', 'agency_owner')`,
    );
    await fixture.owner.unsafe(
      `INSERT INTO clients ("organizationId", name) VALUES ('cccc1111-0000-0000-0000-000000000002', 'C Client')`,
    );

    const rows = await fixture.app.unsafe<{ name: string }[]>(
      `SELECT name FROM clients WHERE "organizationId" = 'cccc1111-0000-0000-0000-000000000002'`,
    );
    expect(rows.length).toBe(0);

    await expect(
      fixture.app.unsafe(
        `INSERT INTO clients ("organizationId", name) VALUES ('cccc1111-0000-0000-0000-000000000002', 'X')`,
      ),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it('callback only ever receives the transaction connection', async () => {
    const backendId = await withTenantContext(
      fixture.app,
      {
        userId: 'cccc1111-0000-0000-0000-000000000001',
        organizationId: 'cccc1111-0000-0000-0000-000000000002',
        role: 'agency_owner',
      },
      async (tx) => {
        const rows = await tx.unsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS pid`);
        const rows2 = await fixture.app.unsafe<{ pid: number }[]>(
          `SELECT pg_backend_pid() AS pid`,
        );
        expect(rows2[0]?.pid).not.toBe(rows[0]?.pid);
        return rows[0]?.pid;
      },
    );
    expect(typeof backendId).toBe('number');
  });
});
