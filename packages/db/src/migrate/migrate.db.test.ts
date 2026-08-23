import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../migrate/runner.js';
import { createFixtureHandle, type FixtureHandle } from '../test/fixtures.js';

let fixture: FixtureHandle;
let ownerUrl: string;

function databaseNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function replaceDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

beforeAll(() => {
  fixture = createFixtureHandle();
  const ownerUrlRaw = process.env.DATABASE_OWNER_URL ?? '';
  const appUrl = process.env.DATABASE_URL ?? '';
  if (!ownerUrlRaw || !appUrl) {
    throw new Error('DATABASE_URL and DATABASE_OWNER_URL are required');
  }
  ownerUrl = replaceDatabaseName(ownerUrlRaw, databaseNameFromUrl(appUrl));
});

afterAll(async () => {
  await fixture.close();
});

describe('migration runner', () => {
  it('records applied migrations and is idempotent', async () => {
    const applied = await fixture.owner.unsafe<{ name: string }[]>(
      `SELECT name FROM schema_migrations ORDER BY name`,
    );
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.map((r) => r.name)).toContain('0001_identity_tenancy.sql');

    // Rerun against the same test database must be fully idempotent.
    const rerun = await applyMigrations(ownerUrl);
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toEqual([
      '0001_identity_tenancy.sql',
      '0002_harden_platform_rls.sql',
      '0003_repair_org_policies.sql',
      '0004_secure_invitation_acceptance.sql',
      '0005_event_platform.sql',
      '0006_lead_domain.sql',
      '0007_phase4_repairs.sql',
      '0008_phase4_security_hardening.sql',
      '0009_approval_domain.sql',
      '0010_phase6a_worker_email.sql',
      '0011_phase6b_incidents_reporting.sql',
      '0012_phase6c_retention.sql',
    ]);
  });
});

describe('schema parity: constraints and types', () => {
  it('all ids are uuid and all timestamps are timestamptz', async () => {
    const rows = await fixture.owner.unsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'id'`,
    );
    for (const row of rows) {
      expect(row.data_type, row.column_name).toBe('uuid');
    }
    const timestamps = await fixture.owner.unsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('createdAt', 'updatedAt', 'expiresAt')`,
    );
    for (const row of timestamps) {
      expect(row.data_type, row.column_name).toBe('timestamp with time zone');
    }
  });

  it('normalized email uniqueness is enforced at database level', async () => {
    await fixture.owner.unsafe(
      `INSERT INTO users (name, email) VALUES ('A', 'MixedCase@Example.com')`,
    );
    await expect(
      fixture.owner.unsafe(`INSERT INTO users (name, email) VALUES ('B', 'mixedcase@example.com')`),
    ).rejects.toThrow(/users_email_lower_unique/);
  });

  it('organization membership unique on (organizationId, userId)', async () => {
    await expect(
      fixture.owner.unsafe(
        "INSERT INTO organization_members (\"organizationId\", \"userId\", role) VALUES ('aaaa1111-0000-0000-0000-0000000000ff', 'aaaa1111-0000-0000-0000-0000000000ee', 'client_viewer')",
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('invitation tokens are unique and at most one pending per (org, email)', async () => {
    const orgId = 'aaaa1111-0000-0000-0000-0000000000f1';
    await fixture.owner.unsafe(`INSERT INTO organizations (id, name, slug) VALUES ('${orgId}', 'O', 'o-1')`);
    const userId = 'aaaa1111-0000-0000-0000-0000000000f2';
    await fixture.owner.unsafe(`INSERT INTO users (id, name, email) VALUES ('${userId}', 'U', 'u@x.dev')`);
    await fixture.owner.unsafe(
      `INSERT INTO invitations ("organizationId", email, role, "tokenHash", status, "expiresAt", "invitedBy")
       VALUES ('${orgId}', 'a@x.dev', 'client_viewer', 'h1', 'pending', now() + interval '1 day', '${userId}')`,
    );
    await expect(
      fixture.owner.unsafe(
        `INSERT INTO invitations ("organizationId", email, role, "tokenHash", status, "expiresAt", "invitedBy")
         VALUES ('${orgId}', 'A@X.DEV', 'client_viewer', 'h2', 'pending', now() + interval '1 day', '${userId}')`,
      ),
    ).rejects.toThrow(/invitations_pending_org_email_unique/);
  });

  it('audit_logs grants: runtime roles have INSERT and SELECT only', async () => {
    const rows = await fixture.owner.unsafe<{ grantee: string; privilege_type: string }[]>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'audit_logs'
         AND grantee IN ('leadops_runtime', 'leadops_runtime_test')`,
    );
    const byRole: Record<string, string[]> = {};
    for (const row of rows) {
      byRole[row.grantee] ??= [];
      const grants = byRole[row.grantee];
      if (grants) grants.push(row.privilege_type);
    }
    for (const role of ['leadops_runtime', 'leadops_runtime_test']) {
      const grants = byRole[role] ?? [];
      expect(grants).toContain('INSERT');
      expect(grants).toContain('SELECT');
      expect(grants).not.toContain('UPDATE');
      expect(grants).not.toContain('DELETE');
    }
  });

  it('invitation updates are restricted to lifecycle columns', async () => {
    const tableGrants = await fixture.owner.unsafe<{ grantee: string; privilege_type: string }[]>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'invitations'
         AND grantee IN ('leadops_runtime', 'leadops_runtime_test')`,
    );
    for (const role of ['leadops_runtime', 'leadops_runtime_test']) {
      expect(
        tableGrants.some((grant) => grant.grantee === role && grant.privilege_type === 'UPDATE'),
      ).toBe(false);
    }

    const columnGrants = await fixture.owner.unsafe<{
      grantee: string;
      column_name: string;
      privilege_type: string;
    }[]>(
      `SELECT grantee, column_name, privilege_type
       FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'invitations'
         AND grantee IN ('leadops_runtime', 'leadops_runtime_test')
         AND privilege_type = 'UPDATE'`,
    );
    for (const role of ['leadops_runtime', 'leadops_runtime_test']) {
      const columns = columnGrants
        .filter((grant) => grant.grantee === role)
        .map((grant) => grant.column_name)
        .sort();
      expect(columns).toEqual(['status', 'updatedAt'].sort());
    }
  });

  it('role check constraints are enforced', async () => {
    const orgId = 'aaaa1111-0000-0000-0000-0000000000f3';
    await fixture.owner.unsafe(`INSERT INTO organizations (id, name, slug) VALUES ('${orgId}', 'O2', 'o-2')`);
    const userId = 'aaaa1111-0000-0000-0000-0000000000f4';
    await fixture.owner.unsafe(`INSERT INTO users (id, name, email) VALUES ('${userId}', 'U2', 'u2@x.dev')`);
    await expect(
      fixture.owner.unsafe(
        `INSERT INTO organization_members ("organizationId", "userId", role)
         VALUES ('${orgId}', '${userId}', 'bogus_role')`,
      ),
    ).rejects.toThrow(/check/i);
  });
});
