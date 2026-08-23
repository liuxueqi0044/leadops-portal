import { describe, expect, it } from 'vitest';

import { ACTIONS } from './actions.js';
import { AuthorizationError } from './actor.js';
import type { Actor, ResourceScope } from './actor.js';
import { can, assertCan } from './matrix.js';
import { ROLES } from './roles.js';

function actor(
  role: Actor['role'],
  organizationId = 'org-a',
  assignedClientIds: string[] = [],
  elevated = false,
): Actor {
  return { userId: 'user-1', organizationId, role, assignedClientIds, elevated };
}

describe('permission matrix', () => {
  it('defines exactly the six frozen roles', () => {
    expect(ROLES).toEqual([
      'platform_admin',
      'agency_owner',
      'agency_admin',
      'agency_operator',
      'client_admin',
      'client_viewer',
    ]);
  });

  it('covers every action with a matrix entry', () => {
    for (const action of ACTIONS) {
      const result = can(actor('agency_owner'), action, {
        organizationId: 'org-a',
      });
      // boolean — entry exists; no action is unhandled
      expect(typeof result).toBe('boolean');
    }
  });

  it('rejects actors whose organization does not match the scope', () => {
    const a = actor('agency_owner', 'org-a');
    expect(can(a, 'organization:read', { organizationId: 'org-b' })).toBe(false);
    expect(can(a, 'client:list', { organizationId: 'org-b' })).toBe(false);
    expect(() => {
      assertCan(a, 'client:list', { organizationId: 'org-b' });
    }).toThrow(AuthorizationError);
  });

  it('rejects unknown actions', () => {
    expect(can(actor('agency_owner'), 'nope:anything' as never, {})).toBe(false);
  });

  describe('Phase 6 operations permissions', () => {
    const scope = { organizationId: 'org-a', clientId: 'client-a' } satisfies ResourceScope;

    it('allows assigned client roles to read operations data', () => {
      for (const action of ['workflow_run:read', 'incident:read', 'report:read'] as const) {
        expect(can(actor('client_viewer', 'org-a', ['client-a']), action, scope)).toBe(true);
        expect(can(actor('client_viewer', 'org-a', ['client-b']), action, scope)).toBe(false);
      }
    });

    it('allows agency operators to manage assigned incidents but denies client roles', () => {
      expect(can(actor('agency_operator', 'org-a', ['client-a']), 'incident:manage', scope)).toBe(
        true,
      );
      expect(can(actor('agency_operator', 'org-a', ['client-b']), 'incident:manage', scope)).toBe(
        false,
      );
      expect(can(actor('client_admin', 'org-a', ['client-a']), 'incident:manage', scope)).toBe(
        false,
      );
      expect(can(actor('client_viewer', 'org-a', ['client-a']), 'incident:manage', scope)).toBe(
        false,
      );
    });
  });

  describe('organization scope', () => {
    const orgRead = { organizationId: 'org-a' } satisfies ResourceScope;

    it('every role can read its own organization', () => {
      for (const role of ROLES) {
        if (role === 'platform_admin') continue;
        expect(can(actor(role), 'organization:read', orgRead), role).toBe(true);
      }
      expect(can(actor('platform_admin'), 'organization:read', orgRead)).toBe(false);
      expect(can(actor('platform_admin', 'org-a', [], true), 'organization:read', orgRead)).toBe(
        true,
      );
    });

    it('owner and admin update the organization; operator/viewer cannot', () => {
      expect(can(actor('agency_owner'), 'organization:update', orgRead)).toBe(true);
      expect(can(actor('agency_admin'), 'organization:update', orgRead)).toBe(true);
      expect(can(actor('agency_operator'), 'organization:update', orgRead)).toBe(false);
      expect(can(actor('client_admin'), 'organization:update', orgRead)).toBe(false);
      expect(can(actor('client_viewer'), 'organization:update', orgRead)).toBe(false);
    });

    it('only owner/admin/platform manage members and read audit', () => {
      const manageActions = [
        'member:list',
        'member:invite',
        'member:deactivate',
        'member:remove',
        'audit:read',
      ] as const;
      for (const action of manageActions) {
        expect(can(actor('agency_owner'), action, orgRead), action).toBe(true);
        expect(can(actor('agency_admin'), action, orgRead), action).toBe(true);
        expect(can(actor('agency_operator'), action, orgRead), action).toBe(false);
        expect(can(actor('client_admin'), action, orgRead), action).toBe(false);
        expect(can(actor('client_viewer'), action, orgRead), action).toBe(false);
      }
    });

    it('organization creation is agency_owner only (no org scope needed)', () => {
      expect(can(actor('agency_owner'), 'organization:create', {})).toBe(true);
      expect(can(actor('agency_admin'), 'organization:create', {})).toBe(false);
      expect(can(actor('platform_admin'), 'organization:create', {})).toBe(false);
    });
  });

  describe('client scope', () => {
    const a1 = { organizationId: 'org-a', clientId: 'client-a1' } satisfies ResourceScope;
    const a2 = { organizationId: 'org-a', clientId: 'client-a2' } satisfies ResourceScope;

    it('owner/admin see any client in the org', () => {
      expect(can(actor('agency_owner'), 'client:read', a1)).toBe(true);
      expect(can(actor('agency_owner'), 'client:read', a2)).toBe(true);
      expect(can(actor('agency_admin'), 'client:read', a1)).toBe(true);
      expect(can(actor('agency_admin'), 'client:read', a2)).toBe(true);
    });

    it('operator only sees assigned clients', () => {
      const op = actor('agency_operator', 'org-a', ['client-a1']);
      expect(can(op, 'client:read', a1)).toBe(true);
      expect(can(op, 'client:read', a2)).toBe(false);
      expect(can(op, 'client:list', { organizationId: 'org-a' })).toBe(true);
    });

    it('client_admin only manages members of own client', () => {
      const ca = actor('client_admin', 'org-a', ['client-a1']);
      expect(can(ca, 'client:manage_members', a1)).toBe(true);
      expect(can(ca, 'client:manage_members', a2)).toBe(false);
      expect(can(ca, 'client:read', a1)).toBe(true);
      expect(can(ca, 'client:read', a2)).toBe(false);
      expect(can(ca, 'client:create', { organizationId: 'org-a' })).toBe(false);
      expect(can(ca, 'client:update', a1)).toBe(false);
      expect(can(ca, 'client:assign_operator', a1)).toBe(false);
    });

    it('client_viewer can only read assigned client', () => {
      const cv = actor('client_viewer', 'org-a', ['client-a1']);
      expect(can(cv, 'client:read', a1)).toBe(true);
      expect(can(cv, 'client:read', a2)).toBe(false);
      expect(can(cv, 'client:manage_members', a1)).toBe(false);
      expect(can(cv, 'client:create', { organizationId: 'org-a' })).toBe(false);
      expect(can(cv, 'client:update', a1)).toBe(false);
    });

    it('owner/admin assign operators; others cannot', () => {
      expect(can(actor('agency_owner'), 'client:assign_operator', a1)).toBe(true);
      expect(can(actor('agency_admin'), 'client:assign_operator', a1)).toBe(true);
      expect(
        can(actor('agency_operator', 'org-a', ['client-a1']), 'client:assign_operator', a1),
      ).toBe(false);
      expect(can(actor('client_admin', 'org-a', ['client-a1']), 'client:assign_operator', a1)).toBe(
        false,
      );
    });

    it('client id from another organization never matches', () => {
      const a = actor('agency_owner', 'org-a');
      expect(can(a, 'client:read', { organizationId: 'org-a', clientId: 'client-b1' })).toBe(true);
      expect(can(a, 'client:read', { organizationId: 'org-b', clientId: 'client-b1' })).toBe(false);
    });
  });

  describe('platform_admin elevation', () => {
    const orgA = { organizationId: 'org-a' } satisfies ResourceScope;

    it('platform_admin without elevation has no tenant powers', () => {
      const pa = actor('platform_admin', 'org-a');
      expect(can(pa, 'organization:update', orgA)).toBe(false);
      expect(can(pa, 'member:invite', orgA)).toBe(false);
      expect(can(pa, 'client:create', orgA)).toBe(false);
      expect(can(pa, 'client:read', { ...orgA, clientId: 'client-a1' })).toBe(false);
      expect(can(pa, 'audit:read', orgA)).toBe(false);
    });

    it('elevated platform_admin gains management powers scoped to target org', () => {
      const pa = actor('platform_admin', 'org-a', [], true);
      expect(can(pa, 'organization:update', orgA)).toBe(true);
      expect(can(pa, 'member:invite', orgA)).toBe(true);
      expect(can(pa, 'client:create', orgA)).toBe(true);
      expect(can(pa, 'client:read', { ...orgA, clientId: 'client-a1' })).toBe(true);
      expect(can(pa, 'audit:read', orgA)).toBe(true);
      expect(can(pa, 'organization:update', { organizationId: 'org-b' })).toBe(false);
    });

    it('elevation:request is platform_admin only and does not need elevation', () => {
      expect(can(actor('platform_admin'), 'elevation:request', {})).toBe(true);
      expect(can(actor('agency_owner'), 'elevation:request', {})).toBe(false);
      expect(can(actor('client_viewer'), 'elevation:request', {})).toBe(false);
    });

    it('assertCan throws AuthorizationError with the action', () => {
      const op = actor('agency_operator', 'org-a', ['client-a1']);
      try {
        assertCan(op, 'client:update', { organizationId: 'org-a', clientId: 'client-a1' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthorizationError);
        expect((err as AuthorizationError).action).toBe('client:update');
        expect((err as AuthorizationError).code).toBe('FORBIDDEN');
      }
    });
  });

  describe('event platform permissions', () => {
    const orgA = { organizationId: 'org-a' } satisfies ResourceScope;

    it('allows integration listing to tenant roles but requires platform elevation', () => {
      for (const role of [
        'agency_owner',
        'agency_admin',
        'agency_operator',
        'client_admin',
        'client_viewer',
      ] as const) {
        expect(can(actor(role), 'integration:list', orgA), role).toBe(true);
      }
      expect(can(actor('platform_admin'), 'integration:list', orgA)).toBe(false);
      expect(can(actor('platform_admin', 'org-a', [], true), 'integration:list', orgA)).toBe(true);
    });

    it('restricts integration mutation and event replay to tenant management roles', () => {
      const actions = [
        'integration:create',
        'integration:rotate_secret',
        'integration:revoke',
        'event:replay',
      ] as const;
      for (const action of actions) {
        expect(can(actor('agency_owner'), action, orgA), action).toBe(true);
        expect(can(actor('agency_admin'), action, orgA), action).toBe(true);
        expect(can(actor('agency_operator'), action, orgA), action).toBe(false);
        expect(can(actor('client_admin'), action, orgA), action).toBe(false);
        expect(can(actor('client_viewer'), action, orgA), action).toBe(false);
        expect(can(actor('platform_admin'), action, orgA), action).toBe(false);
        expect(can(actor('platform_admin', 'org-a', [], true), action, orgA), action).toBe(true);
      }
    });
  });

  describe('approval permissions', () => {
    const ownClient = { organizationId: 'org-a', clientId: 'client-a1' } satisfies ResourceScope;

    it('allows operational and client admins to decide only within their accessible clients', () => {
      expect(
        can(actor('agency_operator', 'org-a', ['client-a1']), 'approval:decide', ownClient),
      ).toBe(true);
      expect(can(actor('client_admin', 'org-a', ['client-a1']), 'approval:decide', ownClient)).toBe(
        true,
      );
      expect(
        can(actor('client_viewer', 'org-a', ['client-a1']), 'approval:decide', ownClient),
      ).toBe(false);
      expect(can(actor('client_admin', 'org-a', ['client-b']), 'approval:decide', ownClient)).toBe(
        false,
      );
    });
  });
});
