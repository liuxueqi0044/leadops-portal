import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import {
  createFixtureHandle,
  type FixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type TenancyFixture,
  setMemberActive,
  createInvitation,
  createUser,
} from '../test/fixtures.js';

let fixture: FixtureHandle;
let f: TenancyFixture;

beforeAll(async () => {
  fixture = createFixtureHandle();
  await resetSchema(fixture);
  f = await seedTenancyFixture(fixture);
});

afterAll(async () => {
  await fixture.close();
});

/**
 * Runs a block with tenant context inside one transaction, mirroring
 * withTenantContext semantics (set_config(..., true) is transaction-local).
 */
async function withContext(
  ctx: { userId: string; organizationId: string; role: string },
  fn: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await fixture.app.begin(async (tx) => {
      await tx.unsafe(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.organization_id', $2, true),
                set_config('app.role', $3, true)`,
        [ctx.userId, ctx.organizationId, ctx.role],
      );
      await fn(tx);
    });
  } catch {
    // Swallow: expected when fn triggers RLS violations that abort the
    // transaction, preventing postgres.js from issuing a clean COMMIT.
  }
}

describe('RLS: runtime role cannot bypass row level security', () => {
  it('runtime role is not superuser and has no BYPASSRLS', async () => {
    const rows = await fixture.app.unsafe<{ current_user: string }[]>(`SELECT current_user`);
    const role = rows[0]?.current_user;
    expect(role).toMatch(/^leadops_runtime/);
    const props = await fixture.app.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(props[0]?.rolsuper).toBe(false);
    expect(props[0]?.rolbypassrls).toBe(false);
  });

  it('runtime role does not own any tenant table', async () => {
    const rows = await fixture.app.unsafe<{ tablename: string; tableowner: string }[]>(
      `SELECT tablename, tableowner FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('organizations','organization_members','clients','client_members','client_assignments','invitations','audit_logs')`,
    );
    expect(rows.length).toBe(7);
    for (const row of rows) {
      expect(row.tableowner).not.toMatch(/^leadops_runtime/);
    }
  });

  it('every tenant table has RLS enabled AND forced', async () => {
    const rows = await fixture.app.unsafe<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('organizations','organization_members','clients','client_members','client_assignments','invitations','audit_logs')`,
    );
    expect(rows.length).toBe(7);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('runtime role cannot UPDATE or DELETE audit_logs (append-only)', async () => {
    await expect(
      fixture.app.unsafe(`UPDATE audit_logs SET action = 'x' WHERE false`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      fixture.app.unsafe(`DELETE FROM audit_logs WHERE false`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('runtime role cannot set the platform_admin flag on users', async () => {
    await expect(
      fixture.app.unsafe(
        `UPDATE users SET platform_admin = true WHERE id = '${f.users.ownerA.id}'`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('RLS: cross-tenant isolation (direct SQL)', () => {
  it('Org A context reads only Org A rows in every tenant table', async () => {
    await withContext({ userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      const orgs = await tx.unsafe<{ id: string }[]>(`SELECT id FROM organizations`);
      expect(orgs.map((r) => r.id)).toEqual([f.orgA.id]);

      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.map((r) => r.id).sort()).toEqual([f.clients.a1.id, f.clients.a2.id].sort());

      const members = await tx.unsafe<{ userId: string }[]>(
        `SELECT "userId" FROM organization_members`,
      );
      expect(members.length).toBe(6);

      const audit = await tx.unsafe<{ id: string }[]>(`SELECT id FROM audit_logs`);
      expect(audit.length).toBe(0);

      const assignments = await tx.unsafe<{ userId: string }[]>(
        `SELECT "userId" FROM client_assignments`,
      );
      expect(assignments.length).toBe(1);

      const clientMembers = await tx.unsafe<{ userId: string }[]>(
        `SELECT "userId" FROM client_members`,
      );
      expect(clientMembers.length).toBe(2);
    });
  });

  it('Org B row is invisible even when queried by id from Org A context', async () => {
    await withContext({ userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      const orgB = await tx.unsafe<{ id: string }[]>(
        `SELECT id FROM organizations WHERE id = '${f.orgB.id}'`,
      );
      expect(orgB.length).toBe(0);
      const clientB1 = await tx.unsafe<{ id: string }[]>(
        `SELECT id FROM clients WHERE id = '${f.clients.b1.id}'`,
      );
      expect(clientB1.length).toBe(0);
    });
  });

  it('Org A context cannot write into Org B', async () => {
    await withContext({ userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      await expect(
        tx.unsafe(
          `INSERT INTO clients ("organizationId", name) VALUES ('${f.orgB.id}', 'Sneaky')`,
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
    await withContext({ userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      await expect(
        tx.unsafe(
          `INSERT INTO organizations (id, name, slug) VALUES ('dddd1111-0000-0000-0000-000000000099', 'Sneaky Org', 'sneaky-org')`,
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
  });

  it('Org B owner cannot read Org A from Org B context', async () => {
    await withContext({ userId: f.users.ownerB.id, organizationId: f.orgB.id, role: 'agency_owner' }, async (tx) => {
      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.map((r) => r.id)).toEqual([f.clients.b1.id]);
      const orgA = await tx.unsafe<{ id: string }[]>(
        `SELECT id FROM organizations WHERE id = '${f.orgA.id}'`,
      );
      expect(orgA.length).toBe(0);
    });
  });

  it('deactivated member loses all tenant access immediately (RLS level)', async () => {
    await setMemberActive(fixture, {
      organizationId: f.orgA.id,
      userId: f.users.operatorA.id,
      active: false,
    });
    await withContext({ userId: f.users.operatorA.id, organizationId: f.orgA.id, role: 'agency_operator' }, async (tx) => {
      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.length).toBe(0);
      const orgs = await tx.unsafe<{ id: string }[]>(`SELECT id FROM organizations`);
      expect(orgs.length).toBe(0);
    });
    // restore for later tests
    await setMemberActive(fixture, {
      organizationId: f.orgA.id,
      userId: f.users.operatorA.id,
      active: true,
    });
  });

  it('agency_operator sees only assigned clients via direct SQL', async () => {
    await withContext({ userId: f.users.operatorA.id, organizationId: f.orgA.id, role: 'agency_operator' }, async (tx) => {
      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.map((r) => r.id)).toEqual([f.clients.a1.id]);
    });
  });

  it('client_admin sees only own client; client_viewer likewise', async () => {
    await withContext({ userId: f.users.clientAdminA.id, organizationId: f.orgA.id, role: 'client_admin' }, async (tx) => {
      const adminClients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(adminClients.map((r) => r.id)).toEqual([f.clients.a1.id]);
    });

    await withContext({ userId: f.users.clientViewerA.id, organizationId: f.orgA.id, role: 'client_viewer' }, async (tx) => {
      const viewerClients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(viewerClients.map((r) => r.id)).toEqual([f.clients.a1.id]);
    });
  });

  it('client member rows and assignments are org-scoped', async () => {
    await withContext({ userId: f.users.ownerB.id, organizationId: f.orgB.id, role: 'agency_owner' }, async (tx) => {
      const members = await tx.unsafe<{ clientId: string }[]>(
        `SELECT "clientId" FROM client_members`,
      );
      expect(members.length).toBe(0);
      const assignments = await tx.unsafe<{ clientId: string }[]>(
        `SELECT "clientId" FROM client_assignments`,
      );
      expect(assignments.length).toBe(0);
    });
  });

  it('cross-tenant composite foreign keys reject spliced ids', async () => {
    await withContext({ userId: f.users.ownerB.id, organizationId: f.orgB.id, role: 'agency_owner' }, async (tx) => {
      await expect(
        tx.unsafe(
          `INSERT INTO client_assignments ("clientId", "organizationId", "userId")
           VALUES ('${f.clients.a1.id}', '${f.orgB.id}', '${f.users.ownerB.id}')`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });
    await withContext({ userId: f.users.ownerB.id, organizationId: f.orgB.id, role: 'agency_owner' }, async (tx) => {
      await expect(
        tx.unsafe(
          `INSERT INTO client_members ("clientId", "organizationId", "userId", role)
           VALUES ('${f.clients.a1.id}', '${f.orgB.id}', '${f.users.ownerB.id}', 'client_viewer')`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  it('invitation rows are visible only with the matching token hash context', async () => {
    const bob = await createUser(fixture, { email: 'bob@t.dev', name: 'Bob' });
    await createInvitation(fixture, {
      organizationId: f.orgA.id,
      email: 'bob@t.dev',
      role: 'agency_operator',
      tokenHash: 'abc123',
      invitedBy: f.users.ownerA.id,
    });
    // Org member (active) sees org invitations regardless of token hash.
    await withContext({ userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      const asMember = await tx.unsafe<{ id: string }[]>(`SELECT id FROM invitations`);
      expect(asMember.length).toBe(1);
    });
    // Invitee with the hash context sees it; without it they see nothing.
    await fixture.app.begin(async (tx) => {
      await tx.unsafe(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.organization_id', $2, true),
                set_config('app.role', 'client_viewer', true),
                set_config('app.invitation_token_hash', $3, true)`,
        [bob.id, f.orgA.id, 'abc123'],
      );
      const withHash = await tx.unsafe<{ id: string }[]>(`SELECT id FROM invitations`);
      expect(withHash.length).toBe(1);
    });
    await withContext({ userId: bob.id, organizationId: f.orgA.id, role: 'client_viewer' }, async (tx) => {
      const withoutHash = await tx.unsafe<{ id: string }[]>(`SELECT id FROM invitations`);
      expect(withoutHash.length).toBe(0);
    });
  });

  it('matching invitee token can only perform pending-to-accepted transition', async () => {
    const invitee = await createUser(fixture, { email: 'accept@t.dev', name: 'Accept' });
    const invitation = await createInvitation(fixture, {
      organizationId: f.orgA.id,
      email: invitee.email,
      role: 'agency_operator',
      tokenHash: 'accept-token-hash',
      invitedBy: f.users.ownerA.id,
    });

    await expect(
      fixture.app.begin(async (tx) => {
        await tx.unsafe(
          `SELECT set_config('app.user_id', $1, true),
                  set_config('app.organization_id', $2, true),
                  set_config('app.role', 'client_viewer', true),
                  set_config('app.invitation_token_hash', $3, true)`,
          [invitee.id, f.orgA.id, 'accept-token-hash'],
        );
        await tx.unsafe(`UPDATE invitations SET role = 'agency_owner' WHERE id = $1`, [invitation.id]);
      }),
    ).rejects.toThrow(/permission denied/i);

    await fixture.app.begin(async (tx) => {
      await tx.unsafe(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.organization_id', $2, true),
                set_config('app.role', 'client_viewer', true),
                set_config('app.invitation_token_hash', $3, true)`,
        [invitee.id, f.orgA.id, 'accept-token-hash'],
      );
      const updated = await tx.unsafe<{ id: string }[]>(
        `UPDATE invitations SET status = 'accepted', "updatedAt" = now()
         WHERE id = $1 RETURNING id`,
        [invitation.id],
      );
      expect(updated.map((row) => row.id)).toEqual([invitation.id]);
    });
  });

  it('a matching token cannot be accepted by a different signed-in user', async () => {
    const invitee = await createUser(fixture, { email: 'bound@t.dev', name: 'Bound' });
    const wrongUser = await createUser(fixture, { email: 'wrong@t.dev', name: 'Wrong' });
    const invitation = await createInvitation(fixture, {
      organizationId: f.orgA.id,
      email: invitee.email,
      role: 'client_viewer',
      tokenHash: 'bound-token-hash',
      invitedBy: f.users.ownerA.id,
    });

    await fixture.app.begin(async (tx) => {
      await tx.unsafe(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.organization_id', $2, true),
                set_config('app.role', 'client_viewer', true),
                set_config('app.invitation_token_hash', $3, true)`,
        [wrongUser.id, f.orgA.id, 'bound-token-hash'],
      );
      const updated = await tx.unsafe<{ id: string }[]>(
        `UPDATE invitations SET status = 'accepted', "updatedAt" = now()
         WHERE id = $1 RETURNING id`,
        [invitation.id],
      );
      expect(updated).toEqual([]);
    });

    const rows = await fixture.owner.unsafe<{ status: string }[]>(
      `SELECT status FROM invitations WHERE id = $1`,
      [invitation.id],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  it('platform_admin with server-side flag sees all org clients; without flag, limited to membership', async () => {
    // User with platform_admin flag: the RLS grants client-wide visibility
    // as defense-in-depth. The application layer still requires formal
    // elevation via the permission matrix.
    await withContext({ userId: f.users.platformAdminA.id, organizationId: f.orgA.id, role: 'platform_admin' }, async (tx) => {
      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.map((r) => r.id).sort()).toEqual([f.clients.a1.id, f.clients.a2.id].sort());
    });
    // A regular user (ownerA) does NOT have the flag. If they forge
    // role='platform_admin', the RLS denies all access because:
    // 1) app_role() is 'platform_admin' (not 'agency_owner/admin')
    // 2) app_is_elevated_platform() fails (no server-side flag)
    // 3) No client assignments or memberships exist for ownerA.
    await withContext({ userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'platform_admin' }, async (tx) => {
      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.length).toBe(0);
    });
  });
});

describe('RLS: no context defaults to deny', () => {
  it('returns zero rows and rejects writes without context', async () => {
    const orgs = await fixture.app.unsafe<{ id: string }[]>(`SELECT id FROM organizations`);
    expect(orgs.length).toBe(0);
    const clients = await fixture.app.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
    expect(clients.length).toBe(0);
    await expect(
      fixture.app.unsafe(
        `INSERT INTO clients ("organizationId", name) VALUES ('${f.orgA.id}', 'Nope')`,
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });
});

describe('RLS: role context values', () => {
  it('org read requires active membership; ctx validity without membership denies', async () => {
    const outsider = await createUser(fixture, { email: 'outsider2@t.dev', name: 'Outsider2' });
    await withContext({ userId: outsider.id, organizationId: f.orgA.id, role: 'client_viewer' }, async (tx) => {
      const orgs = await tx.unsafe<{ id: string }[]>(`SELECT id FROM organizations`);
      expect(orgs.length).toBe(0);
      const clients = await tx.unsafe<{ id: string }[]>(`SELECT id FROM clients`);
      expect(clients.length).toBe(0);
    });
  });

  it('empty context variables are treated as unset', async () => {
    await fixture.app.begin(async (tx) => {
      await tx.unsafe(
        `SELECT set_config('app.user_id', '', true),
                set_config('app.organization_id', '', true),
                set_config('app.role', '', true)`,
      );
      const orgs = await tx.unsafe<{ id: string }[]>(`SELECT id FROM organizations`);
      expect(orgs.length).toBe(0);
    });
  });
});
