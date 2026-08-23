import { assertCan, type Actor, type Role } from '@leadops/core';
import type postgres from 'postgres';

import { withActorContext } from './actor.js';
import { writeAudit } from './audit.js';
import { conflict, invalid, notFound } from './errors.js';

export interface ClientRow {
  id: string;
  organizationId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientListItem {
  id: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

const CLIENT_COLUMNS = 'id, "organizationId", name, status, "createdAt", "updatedAt"';

export interface CreateClientInput {
  organizationId: string;
  name: string;
}

export async function createClient(
  pool: postgres.Sql,
  actor: Actor,
  input: CreateClientInput,
): Promise<ClientRow> {
  assertCan(actor, 'client:create', { organizationId: input.organizationId });
  const name = input.name.trim();
  if (!name) throw invalid('client name is required');

  return withActorContext(pool, actor, undefined, async (tx) => {
    const rows = await tx.unsafe<ClientRow[]>(
      `INSERT INTO clients ("organizationId", name) VALUES ($1, $2)
       RETURNING ${CLIENT_COLUMNS}`,
      [input.organizationId, name],
    );
    const client = rows[0];
    if (!client) throw new Error('client insert returned no row');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'client.created',
      resourceType: 'client',
      resourceId: client.id,
    });
    return client;
  });
}

export interface UpdateClientInput {
  organizationId: string;
  clientId: string;
  name?: string;
  status?: 'active' | 'archived';
}

export async function updateClient(
  pool: postgres.Sql,
  actor: Actor,
  input: UpdateClientInput,
): Promise<ClientRow> {
  assertCan(actor, 'client:update', { organizationId: input.organizationId, clientId: input.clientId });
  const name = input.name?.trim();
  if (name !== undefined && !name) throw invalid('client name cannot be empty');
  if (name === undefined && input.status === undefined) {
    throw invalid('at least one of name or status must be provided');
  }

  return withActorContext(pool, actor, input.clientId, async (tx) => {
    const rows = await tx.unsafe<ClientRow[]>(
      `UPDATE clients
       SET name = COALESCE($3, name), status = COALESCE($4, status), "updatedAt" = now()
       WHERE id = $1 AND "organizationId" = $2
       RETURNING ${CLIENT_COLUMNS}`,
      [input.clientId, input.organizationId, name ?? null, input.status ?? null],
    );
    const client = rows[0];
    if (!client) throw notFound('client not found');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'client.updated',
      resourceType: 'client',
      resourceId: input.clientId,
    });
    return client;
  });
}

export async function getClient(
  pool: postgres.Sql,
  actor: Actor,
  input: { organizationId: string; clientId: string },
): Promise<ClientRow> {
  assertCan(actor, 'client:read', { organizationId: input.organizationId, clientId: input.clientId });
  return withActorContext(pool, actor, input.clientId, async (tx) => {
    const rows = await tx.unsafe<ClientRow[]>(
      `SELECT ${CLIENT_COLUMNS} FROM clients WHERE id = $1 AND "organizationId" = $2`,
      [input.clientId, input.organizationId],
    );
    const client = rows[0];
    if (!client) throw notFound('client not found');
    return client;
  });
}

export interface ListClientsInput {
  organizationId: string;
  limit: number;
  cursor?: string | null;
}

export interface ListClientsResult {
  items: ClientListItem[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw invalid('invalid cursor');
  }
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw invalid('invalid cursor');
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!createdAt || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw invalid('invalid cursor');
  }
  if (Number.isNaN(Date.parse(createdAt))) throw invalid('invalid cursor');
  return { createdAt, id };
}

/**
 * Lists the clients visible to the actor with keyset (cursor) pagination on
 * ("createdAt", id). RLS already restricts visibility; this query only adds
 * ordering and the cursor boundary.
 */
export async function listAccessibleClients(
  pool: postgres.Sql,
  actor: Actor,
  input: ListClientsInput,
): Promise<ListClientsResult> {
  assertCan(actor, 'client:list', { organizationId: input.organizationId });
  const limit = Math.min(Math.max(input.limit, 1), 100);

  return withActorContext(pool, actor, undefined, async (tx) => {
    let rows: ClientListItem[];
    if (input.cursor) {
      const { createdAt, id } = decodeCursor(input.cursor);
      rows = await tx.unsafe<ClientListItem[]>(
        `SELECT ${CLIENT_COLUMNS} FROM clients
         WHERE "organizationId" = $1
           AND ("createdAt", id) < ($2::timestamptz, $3::uuid)
         ORDER BY "createdAt" DESC, id DESC
         LIMIT $4`,
        [input.organizationId, createdAt, id, limit + 1],
      );
    } else {
      rows = await tx.unsafe<ClientListItem[]>(
        `SELECT ${CLIENT_COLUMNS} FROM clients
         WHERE "organizationId" = $1
         ORDER BY "createdAt" DESC, id DESC
         LIMIT $2`,
        [input.organizationId, limit + 1],
      );
    }

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

export interface AddClientMemberInput {
  organizationId: string;
  clientId: string;
  userId: string;
  role: 'client_admin' | 'client_viewer';
}

export async function addClientMember(
  pool: postgres.Sql,
  actor: Actor,
  input: AddClientMemberInput,
): Promise<void> {
  assertCan(actor, 'client:manage_members', {
    organizationId: input.organizationId,
    clientId: input.clientId,
  });

  await withActorContext(pool, actor, input.clientId, async (tx) => {
    const client = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM clients WHERE id = $1 AND "organizationId" = $2`,
      [input.clientId, input.organizationId],
    );
    if (client.length === 0) throw notFound('client not found');

    const member = await tx.unsafe<{ role: string }[]>(
      `SELECT role FROM organization_members
       WHERE "organizationId" = $1 AND "userId" = $2 AND active`,
      [input.organizationId, input.userId],
    );
    if (member.length === 0) throw invalid('user is not an active organization member');

    try {
      await tx.unsafe(
        `INSERT INTO client_members ("clientId", "organizationId", "userId", role)
         VALUES ($1, $2, $3, $4)`,
        [input.clientId, input.organizationId, input.userId, input.role],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('user is already a member of this client');
      throw err;
    }

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'client.member_added',
      resourceType: 'client_member',
      resourceId: input.clientId,
      clientId: input.clientId,
      metadata: { role: input.role, targetUserId: input.userId },
    });
  });
}

export interface RemoveClientMemberInput {
  organizationId: string;
  clientId: string;
  userId: string;
}

export async function removeClientMember(
  pool: postgres.Sql,
  actor: Actor,
  input: RemoveClientMemberInput,
): Promise<void> {
  assertCan(actor, 'client:manage_members', {
    organizationId: input.organizationId,
    clientId: input.clientId,
  });

  await withActorContext(pool, actor, input.clientId, async (tx) => {
    const rows = await tx.unsafe<{ id: string }[]>(
      `DELETE FROM client_members
       WHERE "clientId" = $1 AND "organizationId" = $2 AND "userId" = $3
       RETURNING "userId" AS id`,
      [input.clientId, input.organizationId, input.userId],
    );
    if (rows.length === 0) throw notFound('client member not found');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'client.member_removed',
      resourceType: 'client_member',
      resourceId: input.clientId,
      clientId: input.clientId,
      metadata: { targetUserId: input.userId },
    });
  });
}

export interface AssignOperatorInput {
  organizationId: string;
  clientId: string;
  userId: string;
}

export async function assignOperatorToClient(
  pool: postgres.Sql,
  actor: Actor,
  input: AssignOperatorInput,
): Promise<void> {
  assertCan(actor, 'client:assign_operator', {
    organizationId: input.organizationId,
    clientId: input.clientId,
  });

  await withActorContext(pool, actor, input.clientId, async (tx) => {
    const client = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM clients WHERE id = $1 AND "organizationId" = $2`,
      [input.clientId, input.organizationId],
    );
    if (client.length === 0) throw notFound('client not found');

    const member = await tx.unsafe<{ role: string }[]>(
      `SELECT role FROM organization_members
       WHERE "organizationId" = $1 AND "userId" = $2 AND active`,
      [input.organizationId, input.userId],
    );
    const memberRole = member[0]?.role;
    if (!memberRole) throw invalid('user is not an active organization member');
    if (memberRole !== 'agency_operator') {
      throw invalid('only agency_operator members can be assigned to clients');
    }

    try {
      await tx.unsafe(
        `INSERT INTO client_assignments ("clientId", "organizationId", "userId")
         VALUES ($1, $2, $3)`,
        [input.clientId, input.organizationId, input.userId],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('operator is already assigned to this client');
      throw err;
    }

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'client.operator_assigned',
      resourceType: 'client_assignment',
      resourceId: input.clientId,
      clientId: input.clientId,
      metadata: { targetUserId: input.userId },
    });
  });
}

export interface UnassignOperatorInput {
  organizationId: string;
  clientId: string;
  userId: string;
}

export async function unassignOperatorFromClient(
  pool: postgres.Sql,
  actor: Actor,
  input: UnassignOperatorInput,
): Promise<void> {
  assertCan(actor, 'client:unassign_operator', {
    organizationId: input.organizationId,
    clientId: input.clientId,
  });

  await withActorContext(pool, actor, input.clientId, async (tx) => {
    const rows = await tx.unsafe<{ id: string }[]>(
      `DELETE FROM client_assignments
       WHERE "clientId" = $1 AND "organizationId" = $2 AND "userId" = $3
       RETURNING "userId" AS id`,
      [input.clientId, input.organizationId, input.userId],
    );
    if (rows.length === 0) throw notFound('assignment not found');

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'client.operator_unassigned',
      resourceType: 'client_assignment',
      resourceId: input.clientId,
      clientId: input.clientId,
      metadata: { targetUserId: input.userId },
    });
  });
}

export interface MemberRow {
  userId: string;
  role: Role;
  active: boolean;
}

export async function listOrganizationMembers(
  pool: postgres.Sql,
  actor: Actor,
  organizationId: string,
): Promise<MemberRow[]> {
  assertCan(actor, 'member:list', { organizationId });
  return withActorContext(pool, actor, undefined, async (tx) => {
    const rows = await tx.unsafe<MemberRow[]>(
      `SELECT "userId", role, active FROM organization_members
       WHERE "organizationId" = $1
       ORDER BY "createdAt" ASC`,
      [organizationId],
    );
    return rows;
  });
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
