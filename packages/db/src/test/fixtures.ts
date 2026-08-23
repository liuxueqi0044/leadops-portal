import postgres from 'postgres';

export interface FixtureDatabaseHandle {
  /** Owner connection: seeds fixtures and asserts database state directly. */
  owner: postgres.Sql;
  /** Runtime-role pool: the code under test (withTenantContext, services). */
  app: postgres.Sql;
}

export interface FixtureHandle extends FixtureDatabaseHandle {
  /** Worker-role pool: cross-tenant claims plus machine-context projection. */
  worker: postgres.Sql;
  close(): Promise<void>;
}

const TENANT_TABLES = [
  'audit_logs',
  'client_assignments',
  'client_members',
  'clients',
  'invitations',
  'organization_members',
  'organizations',
  'sessions',
  'accounts',
  'verifications',
  'integrations',
  'integration_secrets',
  'workflows',
  'workflow_runs',
  'business_events',
  'outbox',
  'ai_runs',
  'lead_status_history',
  'leads',
  'approvals',
  'approval_tokens',
  'approval_deliveries',
  'approval_history',
  'email_deliveries',
  'incidents',
  'incident_events',
  'report_snapshots',
] as const;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for database tests`);
  }
  return value;
}

function databaseNameFromUrl(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Cannot derive a valid database name from URL path '${parsed.pathname}'`);
  }
  return name;
}

function replaceDatabaseName(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function workerUrlFromAppUrl(appUrl: string): string {
  const parsed = new URL(appUrl);
  const testRole = parsed.username === 'leadops_runtime_test';
  parsed.username = testRole ? 'leadops_worker_test' : 'leadops_worker';
  parsed.password = testRole ? 'leadops_worker_test_dev' : 'leadops_worker_dev';
  return parsed.toString();
}

/**
 * The fixture owner connection must target the SAME database as the
 * application connection (the test database); DATABASE_OWNER_URL itself may
 * point at a different database on the same server.
 */
export function createFixtureHandle(): FixtureHandle {
  const appUrl = requireEnv('DATABASE_URL');
  const ownerUrlRaw = requireEnv('DATABASE_OWNER_URL');
  const ownerUrl =
    databaseNameFromUrl(appUrl) === databaseNameFromUrl(ownerUrlRaw)
      ? ownerUrlRaw
      : replaceDatabaseName(ownerUrlRaw, databaseNameFromUrl(appUrl));

  const owner = postgres(ownerUrl, { max: 5, connect_timeout: 10 });
  const app = postgres(appUrl, { max: 5, connect_timeout: 10 });
  const worker = postgres(workerUrlFromAppUrl(appUrl), { max: 5, connect_timeout: 10 });
  return {
    owner,
    app,
    worker,
    async close(): Promise<void> {
      await Promise.all([owner.end(), app.end(), worker.end()]);
    },
  };
}

export function createFixtureHandleMax1(): FixtureHandle {
  const appUrl = requireEnv('DATABASE_URL');
  const ownerUrlRaw = requireEnv('DATABASE_OWNER_URL');
  const ownerUrl =
    databaseNameFromUrl(appUrl) === databaseNameFromUrl(ownerUrlRaw)
      ? ownerUrlRaw
      : replaceDatabaseName(ownerUrlRaw, databaseNameFromUrl(appUrl));

  const owner = postgres(ownerUrl, { max: 1, connect_timeout: 10 });
  const app = postgres(appUrl, { max: 1, connect_timeout: 10 });
  const worker = postgres(workerUrlFromAppUrl(appUrl), { max: 1, connect_timeout: 10 });
  return {
    owner,
    app,
    worker,
    async close(): Promise<void> {
      await Promise.all([owner.end(), app.end(), worker.end()]);
    },
  };
}

/** Wipes all fixture data (keeps schema). Must run as the owner. */
export async function resetSchema(fixture: FixtureDatabaseHandle): Promise<void> {
  await fixture.owner.unsafe(
    `TRUNCATE ${TENANT_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await fixture.owner.unsafe('DELETE FROM users');
}

export interface FixtureUser {
  id: string;
  email: string;
  name: string;
}

export async function createUser(
  fixture: FixtureDatabaseHandle,
  input: { email: string; name: string; platformAdmin?: boolean },
): Promise<FixtureUser> {
  const rows = await fixture.owner.unsafe<{ id: string }[]>(
    `INSERT INTO users (name, email, platform_admin)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.name, input.email, input.platformAdmin === true],
  );
  const row = rows[0];
  if (!row) throw new Error('user insert returned no row');
  return { id: row.id, email: input.email, name: input.name };
}

export async function createOrg(
  fixture: FixtureDatabaseHandle,
  input: { name: string; slug: string },
): Promise<{ id: string }> {
  const rows = await fixture.owner.unsafe<{ id: string }[]>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [input.name, input.slug],
  );
  const row = rows[0];
  if (!row) throw new Error('organization insert returned no row');
  return { id: row.id };
}

export async function addMember(
  fixture: FixtureDatabaseHandle,
  input: {
    organizationId: string;
    userId: string;
    role: string;
    active?: boolean;
  },
): Promise<void> {
  await fixture.owner.unsafe(
    `INSERT INTO organization_members ("organizationId", "userId", role, active)
     VALUES ($1, $2, $3, $4)`,
    [input.organizationId, input.userId, input.role, input.active ?? true],
  );
}

export async function setMemberActive(
  fixture: FixtureDatabaseHandle,
  input: { organizationId: string; userId: string; active: boolean },
): Promise<void> {
  await fixture.owner.unsafe(
    `UPDATE organization_members SET active = $3
     WHERE "organizationId" = $1 AND "userId" = $2`,
    [input.organizationId, input.userId, input.active],
  );
}

export async function createClient(
  fixture: FixtureDatabaseHandle,
  input: { organizationId: string; name: string; status?: 'active' | 'archived' },
): Promise<{ id: string }> {
  const rows = await fixture.owner.unsafe<{ id: string }[]>(
    `INSERT INTO clients ("organizationId", name, status)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.organizationId, input.name, input.status ?? 'active'],
  );
  const row = rows[0];
  if (!row) throw new Error('client insert returned no row');
  return { id: row.id };
}

export async function addClientMember(
  fixture: FixtureDatabaseHandle,
  input: {
    clientId: string;
    organizationId: string;
    userId: string;
    role: 'client_admin' | 'client_viewer';
  },
): Promise<void> {
  await fixture.owner.unsafe(
    `INSERT INTO client_members ("clientId", "organizationId", "userId", role)
     VALUES ($1, $2, $3, $4)`,
    [input.clientId, input.organizationId, input.userId, input.role],
  );
}

export async function assignOperator(
  fixture: FixtureDatabaseHandle,
  input: { clientId: string; organizationId: string; userId: string },
): Promise<void> {
  await fixture.owner.unsafe(
    `INSERT INTO client_assignments ("clientId", "organizationId", "userId")
     VALUES ($1, $2, $3)`,
    [input.clientId, input.organizationId, input.userId],
  );
}

export async function createInvitation(
  fixture: FixtureDatabaseHandle,
  input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    invitedBy: string;
    status?: string;
    expiresAt?: Date;
  },
): Promise<{ id: string }> {
  const rows = await fixture.owner.unsafe<{ id: string }[]>(
    `INSERT INTO invitations ("organizationId", email, role, "tokenHash", status, "expiresAt", "invitedBy")
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.organizationId,
      input.email,
      input.role,
      input.tokenHash,
      input.status ?? 'pending',
      input.expiresAt ?? new Date(Date.now() + 60_000),
      input.invitedBy,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('invitation insert returned no row');
  return { id: row.id };
}

export async function countRows(
  fixture: FixtureDatabaseHandle,
  table: 'audit_logs' | 'clients' | 'organizations' | 'invitations' | 'organization_members',
): Promise<number> {
  const rows = await fixture.owner.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM "${table}"`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function createSession(
  fixture: FixtureDatabaseHandle,
  input: {
    userId: string;
    token: string;
    expiresAt?: Date;
    activeOrganizationId?: string | null;
  },
): Promise<void> {
  await fixture.owner.unsafe(
    `INSERT INTO sessions (token, "userId", "expiresAt", active_organization_id)
     VALUES ($1, $2, $3, $4)`,
    [
      input.token,
      input.userId,
      input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      input.activeOrganizationId ?? null,
    ],
  );
}

/** Deterministic fixture: Org A/B, Client A1/A2/B1, six roles. */
export interface TenancyFixture {
  orgA: { id: string };
  orgB: { id: string };
  clients: {
    a1: { id: string };
    a2: { id: string };
    b1: { id: string };
  };
  users: {
    ownerA: FixtureUser;
    adminA: FixtureUser;
    operatorA: FixtureUser;
    clientAdminA: FixtureUser;
    clientViewerA: FixtureUser;
    platformAdminA: FixtureUser;
    ownerB: FixtureUser;
    outsider: FixtureUser;
  };
}

export async function seedTenancyFixture(fixture: FixtureDatabaseHandle): Promise<TenancyFixture> {
  const ownerA = await createUser(fixture, { email: 'owner.a@test.dev', name: 'Owner A' });
  const adminA = await createUser(fixture, { email: 'admin.a@test.dev', name: 'Admin A' });
  const operatorA = await createUser(fixture, { email: 'operator.a@test.dev', name: 'Operator A' });
  const clientAdminA = await createUser(fixture, { email: 'clientadmin.a@test.dev', name: 'Client Admin A' });
  const clientViewerA = await createUser(fixture, { email: 'clientviewer.a@test.dev', name: 'Client Viewer A' });
  const platformAdminA = await createUser(fixture, {
    email: 'platform.a@test.dev',
    name: 'Platform Admin A',
    platformAdmin: true,
  });
  const ownerB = await createUser(fixture, { email: 'owner.b@test.dev', name: 'Owner B' });
  const outsider = await createUser(fixture, { email: 'outsider@test.dev', name: 'Outsider' });

  const orgA = await createOrg(fixture, { name: 'Org A', slug: 'org-a' });
  const orgB = await createOrg(fixture, { name: 'Org B', slug: 'org-b' });

  await addMember(fixture, { organizationId: orgA.id, userId: ownerA.id, role: 'agency_owner' });
  await addMember(fixture, { organizationId: orgA.id, userId: adminA.id, role: 'agency_admin' });
  await addMember(fixture, { organizationId: orgA.id, userId: operatorA.id, role: 'agency_operator' });
  await addMember(fixture, { organizationId: orgA.id, userId: clientAdminA.id, role: 'client_admin' });
  await addMember(fixture, { organizationId: orgA.id, userId: clientViewerA.id, role: 'client_viewer' });
  await addMember(fixture, { organizationId: orgA.id, userId: platformAdminA.id, role: 'client_viewer' });
  await addMember(fixture, { organizationId: orgB.id, userId: ownerB.id, role: 'agency_owner' });

  const a1 = await createClient(fixture, { organizationId: orgA.id, name: 'Client A1' });
  const a2 = await createClient(fixture, { organizationId: orgA.id, name: 'Client A2' });
  const b1 = await createClient(fixture, { organizationId: orgB.id, name: 'Client B1' });

  await assignOperator(fixture, { clientId: a1.id, organizationId: orgA.id, userId: operatorA.id });
  await addClientMember(fixture, { clientId: a1.id, organizationId: orgA.id, userId: clientAdminA.id, role: 'client_admin' });
  await addClientMember(fixture, { clientId: a1.id, organizationId: orgA.id, userId: clientViewerA.id, role: 'client_viewer' });

  return {
    orgA,
    orgB,
    clients: { a1, a2, b1 },
    users: {
      ownerA,
      adminA,
      operatorA,
      clientAdminA,
      clientViewerA,
      platformAdminA,
      ownerB,
      outsider,
    },
  };
}
