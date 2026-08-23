import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import {
  createFixtureHandle,
  resetSchema,
  seedTenancyFixture,
  type FixtureHandle,
  type TenancyFixture,
} from '../test/fixtures.js';
import { withIntegrationContext, withTenantContext } from '../tenancy/context.js';
import { createApproval, createApprovalToken } from './approvals.js';
import { createIntegration } from './integrations.js';

function sql(value: unknown): postgres.Sql {
  return value as postgres.Sql;
}

describe('Phase 5 approval database security', () => {
  let handle: FixtureHandle;
  let seeded: TenancyFixture;
  let actorA: { userId: string; organizationId: string; role: 'agency_owner' };
  let actorB: { userId: string; organizationId: string; role: 'agency_owner' };
  let integrationA: string;
  let integrationA2: string;
  let integrationB: string;

  beforeAll(() => {
    handle = createFixtureHandle();
  });

  beforeEach(async () => {
    await resetSchema(handle);
    seeded = await seedTenancyFixture(handle);
    actorA = {
      userId: seeded.users.ownerA.id,
      organizationId: seeded.orgA.id,
      role: 'agency_owner',
    };
    actorB = {
      userId: seeded.users.ownerB.id,
      organizationId: seeded.orgB.id,
      role: 'agency_owner',
    };
    integrationA = (
      await withTenantContext(handle.app, actorA, async (tx) =>
        createIntegration(sql(tx), {
          organizationId: seeded.orgA.id,
          clientId: seeded.clients.a1.id,
          name: 'security-a',
        }),
      )
    ).integration.id;
    integrationA2 = (
      await withTenantContext(handle.app, actorA, async (tx) =>
        createIntegration(sql(tx), {
          organizationId: seeded.orgA.id,
          clientId: seeded.clients.a1.id,
          name: 'security-a-2',
        }),
      )
    ).integration.id;
    integrationB = (
      await withTenantContext(handle.app, actorB, async (tx) =>
        createIntegration(sql(tx), {
          organizationId: seeded.orgB.id,
          clientId: seeded.clients.b1.id,
          name: 'security-b',
        }),
      )
    ).integration.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function createForA() {
    return withTenantContext(handle.app, actorA, async (tx) =>
      createApproval(sql(tx), {
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
        integrationId: integrationA,
        correlationId: `security-${crypto.randomUUID()}`,
        requestVersion: '1',
        requestedBy: actorA.userId,
        snapshot: { contactName: 'Immutable snapshot' },
      }),
    );
  }

  it('prevents runtime from bypassing the state machine or mutating the snapshot', async () => {
    const approval = await createForA();
    await expect(
      withTenantContext(handle.app, actorA, async (tx) =>
        tx.unsafe(
          `UPDATE approvals
           SET status = 'approved', snapshot = '{"contactName":"tampered"}'::jsonb
           WHERE id = $1`,
          [approval.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);

    const [stored] = await handle.owner.unsafe<{ status: string; snapshot: { contactName: string } }[]>(
      'SELECT status, snapshot FROM approvals WHERE id = $1',
      [approval.id],
    );
    expect(stored).toEqual({
      status: 'pending',
      snapshot: { contactName: 'Immutable snapshot' },
    });
  });

  it('prevents runtime from forging approval history', async () => {
    const approval = await createForA();
    await expect(
      withTenantContext(handle.app, actorA, async (tx) =>
        tx.unsafe(
          `INSERT INTO approval_history
             ("approvalId", "organizationId", "clientId", new_status, "command", "performedBy")
           VALUES ($1, $2, $3, 'approved', 'decide', $4)`,
          [approval.id, seeded.orgA.id, seeded.clients.a1.id, actorA.userId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects forged integration and cross-tenant bindings inside the definer function', async () => {
    await expect(
      withTenantContext(handle.app, actorA, async (tx) =>
        createApproval(sql(tx), {
          organizationId: seeded.orgA.id,
          clientId: seeded.clients.a1.id,
          integrationId: integrationB,
          correlationId: 'forged-integration',
          requestVersion: '1',
          requestedBy: actorA.userId,
          snapshot: { contactName: 'forged' },
        }),
      ),
    ).rejects.toThrow(/integration binding is invalid/);

    await expect(
      withTenantContext(handle.app, actorA, async (tx) =>
        createApproval(sql(tx), {
          organizationId: seeded.orgB.id,
          clientId: seeded.clients.b1.id,
          integrationId: integrationB,
          correlationId: 'cross-tenant',
          requestVersion: '1',
          requestedBy: actorA.userId,
          snapshot: { contactName: 'cross tenant' },
        }),
      ),
    ).rejects.toThrow(/tenant context is not authorized/);
  });

  it('does not let a second integration in the same client read approvals or mint their tokens', async () => {
    const approval = await createForA();
    const secondBinding = {
      integrationId: integrationA2,
      organizationId: seeded.orgA.id,
      clientId: seeded.clients.a1.id,
    };
    const visible = await withIntegrationContext(handle.app, secondBinding, (tx) =>
      tx.unsafe('SELECT id FROM approvals WHERE id = $1', [approval.id]),
    );
    expect(visible).toEqual([]);

    await expect(withIntegrationContext(handle.app, secondBinding, (tx) =>
      createApprovalToken(sql(tx), {
        approvalId: approval.id,
        organizationId: seeded.orgA.id,
        clientId: seeded.clients.a1.id,
      }),
    )).rejects.toThrow(/binding is invalid/);
  });

  it('revokes PUBLIC execution and pins the search path for every Phase 5 definer', async () => {
    const functions = await handle.owner.unsafe<{
      name: string;
      config: string[] | null;
      public_execute: boolean;
    }[]>(
      `SELECT p.proname AS name,
              p.proconfig AS config,
              has_function_privilege('leadops_runtime_test', p.oid, 'EXECUTE')
                AND p.proname LIKE '%approval%' AS public_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND p.proname IN (
           'create_approval_transactional',
           'decide_approval_atomic',
           'insert_approval_token_safe',
           'consume_approval_token_and_decide',
           'revoke_approval_token_safe',
           'expire_pending_approvals',
           'lookup_approval_by_token_hash',
           'claim_approval_delivery_items',
           'mark_approval_delivery_delivered',
           'mark_approval_delivery_failed'
         )
       ORDER BY p.proname`,
    );
    expect(functions).toHaveLength(10);
    expect(functions.every((entry) => entry.config?.includes('search_path=public, pg_temp'))).toBe(
      true,
    );

    const [publicAcl] = await handle.owner.unsafe<{ grants: string }[]>(
      `SELECT count(*)::text AS grants
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.proname = ANY($1::text[])
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'`,
      [functions.map((entry) => entry.name)],
    );
    expect(publicAcl?.grants).toBe('0');
  });
});
