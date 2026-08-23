import { AuthorizationError } from '@leadops/core';
import type { Actor } from '@leadops/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createFixtureHandle,
  type FixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type TenancyFixture,
  createUser,
  createOrg,
} from '../test/fixtures.js';
import {
  addClientMember,
  assignOperatorToClient,
  createClient,
  getClient,
  listAccessibleClients,
  listOrganizationMembers,
  removeClientMember,
  unassignOperatorFromClient,
  updateClient,
} from '../services/clients.js';
import { createOrganization, getOrganization, updateOrganization } from '../services/organizations.js';
import {
  deactivateMember,
  inviteOrganizationMember,
  revokeInvitation,
  normalizeEmail,
  hashInvitationToken,
} from '../services/members.js';
import { requestElevation } from '../services/elevation.js';
import { switchOrganization } from '../services/session.js';
import { withTenantContext } from '../tenancy/context.js';
import { writeAudit } from '../services/audit.js';

function parseMetadataField(meta: unknown, field: string): unknown {
  if (meta === null || meta === undefined) return undefined;
  if (typeof meta === 'object' && !Array.isArray(meta)) return (meta as Record<string,unknown>)[field];
  if (typeof meta === 'string') { try { const p: unknown = JSON.parse(meta); if (p && typeof p === 'object' && !Array.isArray(p)) return (p as Record<string,unknown>)[field]; } catch { /* */ } }
  return undefined;
}

let fixture: FixtureHandle;
let f: TenancyFixture;
function actorOf(user: { id: string }, role: Actor['role'], assignedClientIds: string[] = []): Actor {
  return { userId: user.id, organizationId: f.orgA.id, role, assignedClientIds };
}

beforeAll(async () => { fixture = createFixtureHandle(); await resetSchema(fixture); f = await seedTenancyFixture(fixture); });
afterAll(async () => { await fixture.close(); });

describe('service: organizations', () => {
  it('createOrganization creates org + owner membership + audit atomically', async () => {
    const user = await createUser(fixture, { email: 'founder@t.dev', name: 'Founder' });
    const org = await createOrganization(fixture.app, { userId: user.id, name: 'Founder Org', slug: 'founder-org' });
    expect(org.slug).toBe('founder-org');
    const members = await fixture.owner.unsafe<{ role: string }[]>(`SELECT role FROM organization_members WHERE "organizationId"=$1 AND "userId"=$2`, [org.id, user.id]);
    expect(members[0]?.role).toBe('agency_owner');
    const audit = await fixture.owner.unsafe<{ action: string }[]>(`SELECT action FROM audit_logs WHERE "organizationId"=$1`, [org.id]);
    expect(audit.map(r => r.action)).toEqual(['organization.created']);
  });
  it('duplicate slug rolls back org and audit together', async () => {
    const user = await createUser(fixture, { email: 'founder2@t.dev', name: 'Founder2' });
    await expect(createOrganization(fixture.app, { userId: user.id, name: 'Dup', slug: 'founder-org' })).rejects.toThrow(/unique/i);
    const audit = await fixture.owner.unsafe<{ action: string }[]>(`SELECT action FROM audit_logs WHERE action='organization.created' AND "organizationId"='${f.orgA.id}'`);
    expect(audit.length).toBe(0);
  });
  it('member without permission cannot update the organization', async () => {
    await expect(updateOrganization(fixture.app, actorOf(f.users.clientViewerA, 'client_viewer'), { organizationId: f.orgA.id, name: 'X' })).rejects.toBeInstanceOf(AuthorizationError);
  });
  it('getOrganization returns 404 for a foreign organization', async () => {
    await expect(getOrganization(fixture.app, actorOf(f.users.ownerA, 'agency_owner'), f.orgB.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('service: invitations and members', () => {
  it('invite stores only the token hash and writes audit', async () => {
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const invitation = await inviteOrganizationMember(fixture.app, owner, { organizationId: f.orgA.id, email: 'Invitee@Example.COM', role: 'agency_operator' });
    expect(normalizeEmail(invitation.email)).toBe('invitee@example.com');
    const stored = await fixture.owner.unsafe<{ tokenHash: string }[]>(`SELECT "tokenHash" FROM invitations WHERE id=$1`, [invitation.id]);
    expect(stored[0]?.tokenHash).toBe(hashInvitationToken(invitation.token));
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.tokenHash).not.toContain(invitation.token);
    const a = await fixture.owner.unsafe<{ action: string }[]>(`SELECT action FROM audit_logs WHERE "resourceId"=$1`, [invitation.id]);
    expect(a.map(r => r.action)).toContain('member.invited');
    await revokeInvitation(fixture.app, owner, { organizationId: f.orgA.id, invitationId: invitation.id });
  });
  it('operator cannot invite; duplicate pending invite conflicts', async () => {
    await expect(inviteOrganizationMember(fixture.app, actorOf(f.users.operatorA,'agency_operator'), { organizationId: f.orgA.id, email: 'x1@t.dev', role: 'client_viewer' })).rejects.toBeInstanceOf(AuthorizationError);
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const first = await inviteOrganizationMember(fixture.app, owner, { organizationId: f.orgA.id, email: 'dup@t.dev', role: 'client_viewer' });
    await expect(inviteOrganizationMember(fixture.app, owner, { organizationId: f.orgA.id, email: 'dup@t.dev', role: 'client_viewer' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await revokeInvitation(fixture.app, owner, { organizationId: f.orgA.id, invitationId: first.id });
  });
  it('deactivates a member and revokes their tenant access', async () => {
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const target = await createUser(fixture, { email: 'deact@t.dev', name: 'Deact' });
    await fixture.owner.unsafe(`INSERT INTO organization_members ("organizationId","userId",role) VALUES ($1,$2,'agency_operator')`, [f.orgA.id, target.id]);
    await deactivateMember(fixture.app, owner, { organizationId: f.orgA.id, userId: target.id });
    const m = await fixture.owner.unsafe<{ active: boolean }[]>(`SELECT active FROM organization_members WHERE "organizationId"=$1 AND "userId"=$2`, [f.orgA.id, target.id]);
    expect(m[0]?.active).toBe(false);
    const audit = await fixture.owner.unsafe<{ action: string; metadata: unknown }[]>(`SELECT action, metadata FROM audit_logs WHERE "resourceId"=$1 AND action='member.deactivated'`, [target.id]);
    expect(audit.length).toBe(1);
    expect(parseMetadataField(audit[0]?.metadata, 'role')).toBe('agency_operator');
    const deactActor: Actor = { userId: target.id, organizationId: f.orgA.id, role: 'agency_operator', assignedClientIds: [] };
    const list = await listAccessibleClients(fixture.app, deactActor, { organizationId: f.orgA.id, limit: 10 });
    expect(list.items.length).toBe(0);
  });
  it('agency_admin cannot deactivate owner or admin; self-deactivation is forbidden', async () => {
    const admin = actorOf(f.users.adminA, 'agency_admin');
    await expect(deactivateMember(fixture.app, admin, { organizationId: f.orgA.id, userId: f.users.ownerA.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deactivateMember(fixture.app, admin, { organizationId: f.orgA.id, userId: f.users.adminA.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deactivateMember(fixture.app, actorOf(f.users.ownerA,'agency_owner'), { organizationId: f.orgA.id, userId: f.users.ownerA.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('service: clients', () => {
  it('creates and updates clients with audit', async () => {
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const created = await createClient(fixture.app, owner, { organizationId: f.orgA.id, name: 'C3' });
    expect(created.organizationId).toBe(f.orgA.id);
    const updated = await updateClient(fixture.app, owner, { organizationId: f.orgA.id, clientId: created.id, name: 'C3r', status: 'archived' });
    expect(updated.name).toBe('C3r');
    expect(updated.status).toBe('archived');
    const a = await fixture.owner.unsafe<{ action: string }[]>(`SELECT action FROM audit_logs WHERE "resourceId"=$1 ORDER BY "createdAt"`, [created.id]);
    expect(a.map(r => r.action)).toEqual(['client.created','client.updated']);
  });
  it('operator sees only assigned clients; other clients return 404', async () => {
    const op = actorOf(f.users.operatorA, 'agency_operator', [f.clients.a1.id]);
    const v = await listAccessibleClients(fixture.app, op, { organizationId: f.orgA.id, limit: 10 });
    expect(v.items.map(c => c.id)).toEqual([f.clients.a1.id]);
    expect((await getClient(fixture.app, op, { organizationId: f.orgA.id, clientId: f.clients.a1.id })).id).toBe(f.clients.a1.id);
    await expect(getClient(fixture.app, op, { organizationId: f.orgA.id, clientId: f.clients.a2.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('client_viewer is denied every mutation', async () => {
    const v = actorOf(f.users.clientViewerA, 'client_viewer', [f.clients.a1.id]);
    await expect(createClient(fixture.app, v, { organizationId: f.orgA.id, name: 'X' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(updateClient(fixture.app, v, { organizationId: f.orgA.id, clientId: f.clients.a1.id, name: 'X' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(addClientMember(fixture.app, v, { organizationId: f.orgA.id, clientId: f.clients.a1.id, userId: f.users.ownerA.id, role: 'client_viewer' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(assignOperatorToClient(fixture.app, v, { organizationId: f.orgA.id, clientId: f.clients.a1.id, userId: f.users.operatorA.id })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(removeClientMember(fixture.app, v, { organizationId: f.orgA.id, clientId: f.clients.a1.id, userId: f.users.clientViewerA.id })).rejects.toBeInstanceOf(AuthorizationError);
  });
  it('cross-organization client access is a stable 404', async () => {
    const oA = actorOf(f.users.ownerA, 'agency_owner');
    const oB: Actor = { userId: f.users.ownerB.id, organizationId: f.orgB.id, role: 'agency_owner' };
    await expect(getClient(fixture.app, oA, { organizationId: f.orgA.id, clientId: f.clients.b1.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getClient(fixture.app, oB, { organizationId: f.orgB.id, clientId: f.clients.a1.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateClient(fixture.app, oB, { organizationId: f.orgB.id, clientId: f.clients.a1.id, name: 'H' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('assigns operators and manages client members', async () => {
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const op2 = await createUser(fixture, { email: 'op2@t.dev', name: 'Op2' });
    await fixture.owner.unsafe(`INSERT INTO organization_members ("organizationId","userId",role) VALUES ($1,$2,'agency_operator')`, [f.orgA.id, op2.id]);
    await assignOperatorToClient(fixture.app, owner, { organizationId: f.orgA.id, clientId: f.clients.a2.id, userId: op2.id });
    await expect(assignOperatorToClient(fixture.app, owner, { organizationId: f.orgA.id, clientId: f.clients.a2.id, userId: f.users.clientAdminA.id })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(assignOperatorToClient(fixture.app, owner, { organizationId: f.orgA.id, clientId: f.clients.a2.id, userId: op2.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(assignOperatorToClient(fixture.app, owner, { organizationId: f.orgA.id, clientId: f.clients.a2.id, userId: f.users.ownerB.id })).rejects.toMatchObject({ code: 'INVALID' });
    await unassignOperatorFromClient(fixture.app, owner, { organizationId: f.orgA.id, clientId: f.clients.a2.id, userId: op2.id });
    const ca = actorOf(f.users.clientAdminA, 'client_admin', [f.clients.a1.id]);
    await addClientMember(fixture.app, ca, { organizationId: f.orgA.id, clientId: f.clients.a1.id, userId: f.users.operatorA.id, role: 'client_viewer' });
    await expect(addClientMember(fixture.app, ca, { organizationId: f.orgA.id, clientId: f.clients.a2.id, userId: f.users.operatorA.id, role: 'client_viewer' })).rejects.toBeInstanceOf(AuthorizationError);
    await removeClientMember(fixture.app, ca, { organizationId: f.orgA.id, clientId: f.clients.a1.id, userId: f.users.operatorA.id });
    const outsider = await createUser(fixture, { email: 'notm@t.dev', name: 'NotM' });
    await expect(addClientMember(fixture.app, ca, { organizationId: f.orgA.id, clientId: f.clients.a1.id, userId: outsider.id, role: 'client_viewer' })).rejects.toMatchObject({ code: 'INVALID' });
  });
  it('paginates clients with a keyset cursor', async () => {
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const p1 = await listAccessibleClients(fixture.app, owner, { organizationId: f.orgA.id, limit: 2 });
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listAccessibleClients(fixture.app, owner, { organizationId: f.orgA.id, limit: 2, cursor: p1.nextCursor });
    expect(p2.items.length).toBeGreaterThan(0);
    const ids = [...p1.items, ...p2.items].map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const p3 = await listAccessibleClients(fixture.app, owner, { organizationId: f.orgA.id, limit: 100, cursor: p2.nextCursor });
    expect(p3.nextCursor).toBeNull();
    await expect(listAccessibleClients(fixture.app, owner, { organizationId: f.orgA.id, limit: 10, cursor: 'bad' })).rejects.toMatchObject({ code: 'INVALID' });
  });
  it('listOrganizationMembers is management-only', async () => {
    const m = await listOrganizationMembers(fixture.app, actorOf(f.users.ownerA,'agency_owner'), f.orgA.id);
    expect(m.length).toBeGreaterThanOrEqual(6);
    await expect(listOrganizationMembers(fixture.app, actorOf(f.users.operatorA,'agency_operator'), f.orgA.id)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('service: session and elevation', () => {
  it('switchOrganization updates session field after re-validating membership', async () => {
    const mu = await createUser(fixture, { email: 'multi@t.dev', name: 'Multi' });
    await fixture.owner.unsafe(`INSERT INTO organization_members ("organizationId","userId",role) VALUES ($1,$2,'agency_admin'),($3,$2,'client_viewer')`, [f.orgA.id, mu.id, f.orgB.id]);
    await fixture.owner.unsafe(`INSERT INTO sessions (token,"userId","expiresAt",active_organization_id) VALUES ('st1',$1,now()+interval'1day',$2)`, [mu.id, f.orgA.id]);
    const sw = await switchOrganization(fixture.app, { sessionToken: 'st1', userId: mu.id, targetOrganizationId: f.orgB.id });
    expect(sw.organizationId).toBe(f.orgB.id);
    const s = await fixture.owner.unsafe<{ active_organization_id: string|null }[]>(`SELECT active_organization_id FROM sessions WHERE token='st1'`);
    expect(s[0]?.active_organization_id).toBe(f.orgB.id);
    const a = await fixture.owner.unsafe<{ action: string }[]>(`SELECT action FROM audit_logs WHERE action='session.organization_switched' AND "organizationId"=$1`, [f.orgB.id]);
    expect(a.length).toBe(1);
    const so = await createOrg(fixture, { name: 'Stranger', slug: 'stranger' });
    await expect(switchOrganization(fixture.app, { sessionToken: 'st1', userId: mu.id, targetOrganizationId: so.id })).rejects.toMatchObject({ code: 'INVALID' });
  });
  it('switchOrganization rolls back session update when audit write fails', async () => {
    const mu = await createUser(fixture, { email: 'm2@t.dev', name: 'M2' });
    await fixture.owner.unsafe(`INSERT INTO organization_members ("organizationId","userId",role) VALUES ($1,$2,'agency_admin'),($3,$2,'client_viewer')`, [f.orgA.id, mu.id, f.orgB.id]);
    const st = 'st-fault';
    await fixture.owner.unsafe(`INSERT INTO sessions (token,"userId","expiresAt",active_organization_id) VALUES ($1,$2,now()+interval'1day',$3)`, [st, mu.id, f.orgA.id]);
    const b = await fixture.owner.unsafe<{ active_organization_id: string|null }[]>(`SELECT active_organization_id FROM sessions WHERE token=$1`, [st]);
    expect(b[0]?.active_organization_id).toBe(f.orgA.id);
    await expect(withTenantContext(fixture.app, { userId: mu.id, organizationId: f.orgB.id, role: 'agency_admin' }, async (tx) => {
      await tx.unsafe(`UPDATE sessions SET active_organization_id=$1,"updatedAt"=now() WHERE token=$2 AND "userId"=$3`, [f.orgB.id, st, mu.id]);
      await tx.unsafe(`INSERT INTO audit_logs ("organizationId","actorUserId",action,"resourceType",metadata) VALUES ($1,$2,$3,'session','{}'::jsonb)`, [f.orgB.id, mu.id, 'x'.repeat(300)]);
    })).rejects.toThrow();
    const a2 = await fixture.owner.unsafe<{ active_organization_id: string|null }[]>(`SELECT active_organization_id FROM sessions WHERE token=$1`, [st]);
    expect(a2[0]?.active_organization_id).toBe(f.orgA.id);
  });
  it('elevation requires platform flag, membership, reason, writes audit', async () => {
    await expect(requestElevation(fixture.app, { userId: f.users.ownerA.id, targetOrganizationId: f.orgA.id, reason: 'triage' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const el = await requestElevation(fixture.app, { userId: f.users.platformAdminA.id, targetOrganizationId: f.orgA.id, reason: 'customer triage' });
    expect(el.role).toBe('platform_admin');
    expect(el.elevated).toBe(true);
    expect(el.organizationId).toBe(f.orgA.id);
    const a = await fixture.owner.unsafe<{ action: string; metadata: unknown }[]>(`SELECT action, metadata FROM audit_logs WHERE action='platform_admin.elevated' AND "organizationId"=$1`, [f.orgA.id]);
    expect(a.length).toBe(1);
    expect(parseMetadataField(a[0]?.metadata, 'reason')).toBe('customer triage');
    await expect(requestElevation(fixture.app, { userId: f.users.platformAdminA.id, targetOrganizationId: f.orgB.id, reason: 'fail' })).rejects.toMatchObject({ code: 'INVALID' });
  });
});

describe('service: audit atomicity', () => {
  it('business write and audit succeed together', async () => {
    const owner = actorOf(f.users.ownerA, 'agency_owner');
    const b = await fixture.owner.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM audit_logs WHERE "organizationId"=$1`, [f.orgA.id]);
    await createClient(fixture.app, owner, { organizationId: f.orgA.id, name: 'Atomic' });
    const a = await fixture.owner.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM audit_logs WHERE "organizationId"=$1`, [f.orgA.id]);
    expect(Number(a[0]?.n)).toBe(Number(b[0]?.n) + 1);
  });
  it('rolls back audit when business write fails', async () => {
    const b = await fixture.owner.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM audit_logs WHERE "organizationId"=$1`, [f.orgA.id]);
    await expect(withTenantContext(fixture.app, { userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      await writeAudit(tx, { organizationId: f.orgA.id, actorUserId: f.users.ownerA.id, action: 'client.created', resourceType: 'client' });
      await tx.unsafe(`INSERT INTO clients ("organizationId",name) VALUES ($1,$2)`, [f.orgA.id, 'x'.repeat(300)]);
    })).rejects.toThrow();
    const a = await fixture.owner.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM audit_logs WHERE "organizationId"=$1`, [f.orgA.id]);
    expect(Number(a[0]?.n)).toBe(Number(b[0]?.n));
  });
  it('rolls back business when audit fails', async () => {
    const b = await fixture.owner.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM clients WHERE "organizationId"=$1`, [f.orgA.id]);
    await expect(withTenantContext(fixture.app, { userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      await tx.unsafe(`INSERT INTO clients ("organizationId",name) VALUES ($1,$2)`, [f.orgA.id, 'AuditFail']);
      await tx.unsafe(`INSERT INTO audit_logs ("organizationId","actorUserId",action,"resourceType",metadata) VALUES ($1,$2,$3,'client','{}'::jsonb)`, [f.orgA.id, f.users.ownerA.id, 'x'.repeat(300)]);
    })).rejects.toThrow();
    const a = await fixture.owner.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM clients WHERE "organizationId"=$1`, [f.orgA.id]);
    expect(Number(a[0]?.n)).toBe(Number(b[0]?.n));
  });
  it('audit metadata whitelist drops tokens and PII', async () => {
    await withTenantContext(fixture.app, { userId: f.users.ownerA.id, organizationId: f.orgA.id, role: 'agency_owner' }, async (tx) => {
      await writeAudit(tx, { organizationId: f.orgA.id, actorUserId: f.users.ownerA.id, action: 'client.created', resourceType: 'client', metadata: { reason: 'ok', role: 'agency_owner', token: 'secret', cookie: 'c', authorization: 'Bearer x', email: 'pii@t.dev' } });
    });
    const rows = await fixture.owner.unsafe<{ metadata: unknown }[]>(`SELECT metadata FROM audit_logs ORDER BY "createdAt" DESC LIMIT 1`);
    const meta = rows[0]?.metadata;
    expect(parseMetadataField(meta, 'reason')).toBe('ok');
    expect(parseMetadataField(meta, 'role')).toBe('agency_owner');
    expect(parseMetadataField(meta, 'token')).toBeUndefined();
    expect(parseMetadataField(meta, 'cookie')).toBeUndefined();
    expect(parseMetadataField(meta, 'authorization')).toBeUndefined();
    expect(parseMetadataField(meta, 'email')).toBeUndefined();
  });
});
