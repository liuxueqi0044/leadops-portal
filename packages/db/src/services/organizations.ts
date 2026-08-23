import { assertCan, type Actor } from '@leadops/core';
import type postgres from 'postgres';

import { withTenantContext } from '../tenancy/context.js';
import { withActorContext } from './actor.js';
import { writeAudit } from './audit.js';
import { invalid, notFound } from './errors.js';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

const ORGANIZATION_COLUMNS = 'id, name, slug, "createdAt", "updatedAt"';

export interface CreateOrganizationInput {
  userId: string;
  name: string;
  slug: string;
}

/**
 * Creates an organization and makes the caller its agency_owner in the same
 * transaction. The organization id is generated first and the tenant context
 * is opened on it (RLS: organizations_insert requires id = context org).
 */
export async function createOrganization(
  pool: postgres.Sql,
  input: CreateOrganizationInput,
): Promise<OrganizationRow> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name) throw invalid('organization name is required');
  if (!slug) throw invalid('organization slug is required');
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug)) {
    throw invalid('organization slug must be 1-64 chars of lowercase letters, digits, hyphens');
  }

  const [gen] = await pool.unsafe<{ id: string }[]>('SELECT gen_random_uuid() AS id');
  if (!gen) throw new Error('failed to generate organization id');
  const organizationId = gen.id;

  return withTenantContext(
    pool,
    { userId: input.userId, organizationId, role: 'agency_owner' },
    async (tx) => {
      const rows = await tx.unsafe<OrganizationRow[]>(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)
         RETURNING ${ORGANIZATION_COLUMNS}`,
        [organizationId, name, slug],
      );
      const org = rows[0];
      if (!org) throw new Error('organization insert returned no row');

      await tx.unsafe(
        `INSERT INTO organization_members ("organizationId", "userId", role)
         VALUES ($1, $2, 'agency_owner')`,
        [organizationId, input.userId],
      );
      await writeAudit(tx, {
        organizationId,
        actorUserId: input.userId,
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: organizationId,
      });
      return org;
    },
  );
}

export interface UpdateOrganizationInput {
  organizationId: string;
  name?: string;
  slug?: string;
}

export async function updateOrganization(
  pool: postgres.Sql,
  actor: Actor,
  input: UpdateOrganizationInput,
): Promise<OrganizationRow> {
  const name = input.name?.trim();
  const slug = input.slug?.trim().toLowerCase();
  if (name !== undefined && !name) throw invalid('organization name cannot be empty');
  if (slug !== undefined && !slug) throw invalid('organization slug cannot be empty');
  if (name === undefined && slug === undefined) {
    throw invalid('at least one of name or slug must be provided');
  }

  return withActorContext(pool, actor, undefined, async (tx) => {
    // Visibility first: unreachable (cross-tenant) resources are a stable 404,
    // even when the caller is otherwise unauthorized.
    const visible = await tx.unsafe<{ id: string }[]>(
      `SELECT id FROM organizations WHERE id = $1`,
      [input.organizationId],
    );
    if (visible.length === 0) throw notFound('organization not found');

    assertCan(actor, 'organization:update', { organizationId: input.organizationId });

    const rows = await tx.unsafe<OrganizationRow[]>(
      `UPDATE organizations
       SET name = COALESCE($2, name), slug = COALESCE($3, slug), "updatedAt" = now()
       WHERE id = $1
       RETURNING ${ORGANIZATION_COLUMNS}`,
      [input.organizationId, name ?? null, slug ?? null],
    );
    const org = rows[0];
    if (!org) throw notFound('organization not found');
    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: actor.userId,
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: input.organizationId,
    });
    return org;
  });
}

export async function getOrganization(
  pool: postgres.Sql,
  actor: Actor,
  organizationId: string,
): Promise<OrganizationRow> {
  return withActorContext(pool, actor, undefined, async (tx) => {
    // Read authorization is row-level security: the organization is only
    // reachable from an active membership context. Unreachable → 404.
    const rows = await tx.unsafe<OrganizationRow[]>(
      `SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = $1`,
      [organizationId],
    );
    const org = rows[0];
    if (!org) throw notFound('organization not found');
    return org;
  });
}
