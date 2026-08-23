import type { Actor } from '@leadops/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import {
  addMember,
  assignOperator,
  addClientMember,
  createUser as fixtureCreateUser,
  createOrg,
  createClient as fixtureCreateClient,
  type TenancyFixture,
} from '../test/fixtures.js';
import {
  acceptInvitation,
  createInvitationToken,
  inviteOrganizationMember,
} from '../services/members.js';
import { getClient } from '../services/clients.js';

function databaseNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}
function replaceDatabaseName(url: string, dbName: string): string {
  const u = new URL(url); u.pathname = '/' + dbName; return u.toString();
}
function requireEnv(name: string): string {
  const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v;
}

interface LocalFixture {
  owner: postgres.Sql;
  app: postgres.Sql;
  close(): Promise<void>;
}

function createLocalFixture(): LocalFixture {
  const appUrl = requireEnv('DATABASE_URL');
  const ownerRaw = requireEnv('DATABASE_OWNER_URL');
  const ownerUrl = databaseNameFromUrl(appUrl) === databaseNameFromUrl(ownerRaw)
    ? ownerRaw : replaceDatabaseName(ownerRaw, databaseNameFromUrl(appUrl));
  const owner = postgres(ownerUrl, { max: 1, connect_timeout: 10 });
  const app = postgres(appUrl, { max: 1, connect_timeout: 10 });
  return { owner, app, close: async () => { await Promise.all([owner.end(), app.end()]); } };
}

const TENANT_TABLES = [
  'audit_logs', 'client_assignments', 'client_members', 'clients',
  'invitations', 'organization_members', 'organizations',
  'sessions', 'accounts', 'verifications',
] as const;

async function localResetSchema(fixture: LocalFixture): Promise<void> {
  await fixture.owner.unsafe(
    `TRUNCATE ${TENANT_TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await fixture.owner.unsafe('DELETE FROM users');
}

async function localSeed(fixture: LocalFixture): Promise<TenancyFixture> {
  const ownerA = await fixtureCreateUser(fixture, { email: 'oa@t.dev', name: 'OA' });
  const adminA = await fixtureCreateUser(fixture, { email: 'aa@t.dev', name: 'AA' });
  const operatorA = await fixtureCreateUser(fixture, { email: 'opa@t.dev', name: 'OpA' });
  const clientAdminA = await fixtureCreateUser(fixture, { email: 'caa@t.dev', name: 'CAA' });
  const clientViewerA = await fixtureCreateUser(fixture, { email: 'cva@t.dev', name: 'CVA' });
  const platformAdminA = await fixtureCreateUser(fixture, { email: 'pa@t.dev', name: 'PA', platformAdmin: true });
  const ownerB = await fixtureCreateUser(fixture, { email: 'ob@t.dev', name: 'OB' });
  const outsider = await fixtureCreateUser(fixture, { email: 'os@t.dev', name: 'OS' });

  const orgA = await createOrg(fixture, { name: 'OA', slug: 'oa' });
  const orgB = await createOrg(fixture, { name: 'OB', slug: 'ob' });

  await addMember(fixture, { organizationId: orgA.id, userId: ownerA.id, role: 'agency_owner' });
  await addMember(fixture, { organizationId: orgA.id, userId: adminA.id, role: 'agency_admin' });
  await addMember(fixture, { organizationId: orgA.id, userId: operatorA.id, role: 'agency_operator' });
  await addMember(fixture, { organizationId: orgA.id, userId: clientAdminA.id, role: 'client_admin' });
  await addMember(fixture, { organizationId: orgA.id, userId: clientViewerA.id, role: 'client_viewer' });
  await addMember(fixture, { organizationId: orgA.id, userId: platformAdminA.id, role: 'client_viewer' });
  await addMember(fixture, { organizationId: orgB.id, userId: ownerB.id, role: 'agency_owner' });

  const a1 = await fixtureCreateClient(fixture, { organizationId: orgA.id, name: 'CA1' });
  const a2 = await fixtureCreateClient(fixture, { organizationId: orgA.id, name: 'CA2' });
  const b1 = await fixtureCreateClient(fixture, { organizationId: orgB.id, name: 'CB1' });

  await assignOperator(fixture, { clientId: a1.id, organizationId: orgA.id, userId: operatorA.id });
  await addClientMember(fixture, { clientId: a1.id, organizationId: orgA.id, userId: clientAdminA.id, role: 'client_admin' });
  await addClientMember(fixture, { clientId: a1.id, organizationId: orgA.id, userId: clientViewerA.id, role: 'client_viewer' });

  return {
    orgA, orgB,
    clients: { a1, a2, b1 },
    users: { ownerA, adminA, operatorA, clientAdminA, clientViewerA, platformAdminA, ownerB, outsider },
  };
}

let fixture: LocalFixture;
let f: TenancyFixture;

beforeAll(async () => {
  fixture = createLocalFixture();
  await localResetSchema(fixture);
  f = await localSeed(fixture);
});

afterAll(async () => {
  await fixture.close();
});

describe('service: invitation runtime-role regression', () => {
  it('invite + accept on runtime role: membership, status, audit atomic', async () => {
    const owner: Actor = { userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' };
    const invitee = await fixtureCreateUser(fixture, { email: 'rt1@t.dev', name: 'R1' });
    const invitation = await inviteOrganizationMember(fixture.app, owner, {
      organizationId: f.orgA.id, email: invitee.email, role: 'agency_admin',
    });
    const result = await acceptInvitation(fixture.app, { userId: invitee.id, token: invitation.token });
    expect(result.organizationId).toBe(f.orgA.id);
    expect(result.role).toBe('agency_admin');
    const m = await fixture.owner.unsafe<{ role: string }[]>(
      `SELECT role FROM organization_members WHERE "organizationId"=$1 AND "userId"=$2`,
      [f.orgA.id, invitee.id],
    );
    expect(m[0]?.role).toBe('agency_admin');
    const i = await fixture.owner.unsafe<{ status: string }[]>(
      `SELECT status FROM invitations WHERE id=$1`, [invitation.id],
    );
    expect(i[0]?.status).toBe('accepted');
    const a = await fixture.owner.unsafe<{ action: string }[]>(
      `SELECT action FROM audit_logs WHERE "resourceId"=$1`, [invitation.id],
    );
    expect(a.map(r => r.action)).toContain('member.invitation_accepted');
  });

  it('runtime-role reject: unknown, expired, revoked, repeated, wrong-user tokens', async () => {
    const bob = await fixtureCreateUser(fixture, { email: 'rt2b@t.dev', name: 'R2B' });
    const alice = await fixtureCreateUser(fixture, { email: 'rt2a@t.dev', name: 'R2A' });
    const charlie = await fixtureCreateUser(fixture, { email: 'rt2c@t.dev', name: 'R2C' });
    await expect(acceptInvitation(fixture.app, { userId: bob.id, token: 'no' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    const e = createInvitationToken();
    await fixture.owner.unsafe(
      `INSERT INTO invitations ("organizationId",email,role,"tokenHash",status,"expiresAt","invitedBy")
       VALUES($1,$2,'client_viewer',$3,'pending',$4,$5)`,
      [f.orgA.id, bob.email, e.tokenHash, new Date(Date.now() - 1000), f.users.ownerA.id],
    );
    await expect(acceptInvitation(fixture.app, { userId: bob.id, token: e.token }))
      .rejects.toMatchObject({ code: 'EXPIRED' });
    const r = createInvitationToken();
    await fixture.owner.unsafe(
      `INSERT INTO invitations ("organizationId",email,role,"tokenHash",status,"expiresAt","invitedBy")
       VALUES($1,$2,'client_viewer',$3,'revoked',$4,$5)`,
      [f.orgA.id, bob.email, r.tokenHash, new Date(Date.now() + 60000), f.users.ownerA.id],
    );
    await expect(acceptInvitation(fixture.app, { userId: bob.id, token: r.token }))
      .rejects.toMatchObject({ code: 'INVALID' });
    const at = createInvitationToken();
    await fixture.owner.unsafe(
      `INSERT INTO invitations ("organizationId",email,role,"tokenHash",status,"expiresAt","invitedBy")
       VALUES($1,$2,'client_viewer',$3,'pending',$4,$5)`,
      [f.orgA.id, alice.email, at.tokenHash, new Date(Date.now() + 60000), f.users.ownerA.id],
    );
    await expect(acceptInvitation(fixture.app, { userId: bob.id, token: at.token }))
      .rejects.toMatchObject({ code: 'INVALID' });
    const ms = await fixture.owner.unsafe<{ userId: string }[]>(
      `SELECT "userId" FROM organization_members WHERE "organizationId"=$1 AND "userId"=$2`,
      [f.orgA.id, bob.id],
    );
    expect(ms.length).toBe(0);
    const ct = createInvitationToken();
    await fixture.owner.unsafe(
      `INSERT INTO invitations ("organizationId",email,role,"tokenHash",status,"expiresAt","invitedBy")
       VALUES($1,$2,'client_viewer',$3,'pending',$4,$5)`,
      [f.orgA.id, charlie.email, ct.tokenHash, new Date(Date.now() + 60000), f.users.ownerA.id],
    );
    await acceptInvitation(fixture.app, { userId: charlie.id, token: ct.token });
    await expect(acceptInvitation(fixture.app, { userId: charlie.id, token: ct.token }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('runtime-role: token binds to org only, no cross-tenant access', async () => {
    const bActor: Actor = { userId: f.users.ownerB.id, organizationId: f.orgB.id, role: 'agency_owner' };
    const dave = await fixtureCreateUser(fixture, { email: 'rt3@t.dev', name: 'R3' });
    const invB = await inviteOrganizationMember(fixture.app, bActor, {
      organizationId: f.orgB.id, email: dave.email, role: 'agency_operator',
    });
    const result = await acceptInvitation(fixture.app, { userId: dave.id, token: invB.token });
    expect(result.organizationId).toBe(f.orgB.id);
    const orgA = await fixture.owner.unsafe<{ userId: string }[]>(
      `SELECT "userId" FROM organization_members WHERE "organizationId"=$1 AND "userId"=$2`,
      [f.orgA.id, dave.id],
    );
    expect(orgA.length).toBe(0);
    const orgB = await fixture.owner.unsafe<{ userId: string }[]>(
      `SELECT "userId" FROM organization_members WHERE "organizationId"=$1 AND "userId"=$2`,
      [f.orgB.id, dave.id],
    );
    expect(orgB.length).toBe(1);
    const daveActor: Actor = {
      userId: dave.id, organizationId: f.orgB.id, role: 'agency_operator', assignedClientIds: [],
    };
    await expect(
      getClient(fixture.app, daveActor, { organizationId: f.orgA.id, clientId: f.clients.a1.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
