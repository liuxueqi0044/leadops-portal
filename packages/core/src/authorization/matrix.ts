import type { Action } from './actions.js';
import { AuthorizationError } from './actor.js';
import type { Actor, ResourceScope } from './actor.js';
import type { Role } from './roles.js';

export const ALL_ROLES: readonly Role[] = [
  'platform_admin',
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'client_admin',
  'client_viewer',
];

const OWNER_LEVEL: readonly Role[] = ['agency_owner', 'agency_admin'];
const CLIENT_WIDE: readonly Role[] = ['agency_owner', 'agency_admin', 'platform_admin'];
const MANAGEMENT: readonly Role[] = ['agency_owner', 'agency_admin', 'platform_admin'];
const OPERATIONS_MANAGEMENT: readonly Role[] = [
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'platform_admin',
];
const APPROVAL_MANAGEMENT: readonly Role[] = [
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'client_admin',
  'platform_admin',
];

export interface MatrixEntry {
  roles: readonly Role[];
  scope: 'organization' | 'client' | 'platform';
  /** Roles that can act on any client inside the organization without an
   *  explicit assignment/membership. */
  clientWideRoles?: readonly Role[];
  /** platform_admin requires audited elevation for this action. */
  elevatedRequired?: boolean;
}

/**
 * Table-driven authorization matrix. Routes and services never contain
 * `role === ...` checks; they call can()/assertCan() only.
 */
export const MATRIX: Record<Action, MatrixEntry> = {
  'organization:create': {
    roles: ['agency_owner'],
    scope: 'platform',
  },
  'organization:read': {
    roles: ALL_ROLES,
    scope: 'organization',
    elevatedRequired: true,
  },
  'organization:update': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'member:list': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'member:invite': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'member:deactivate': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'member:remove': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'client:list': {
    roles: ALL_ROLES,
    scope: 'organization',
    elevatedRequired: true,
  },
  'client:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'client:create': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'client:update': {
    roles: MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'client:manage_members': {
    roles: [...OWNER_LEVEL, 'platform_admin', 'client_admin'],
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'client:assign_operator': {
    roles: MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'client:unassign_operator': {
    roles: MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'audit:read': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'elevation:request': {
    roles: ['platform_admin'],
    scope: 'platform',
  },
  'integration:list': {
    roles: ALL_ROLES,
    scope: 'organization',
    elevatedRequired: true,
  },
  'integration:create': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'integration:rotate_secret': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'integration:revoke': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'event:replay': {
    roles: MANAGEMENT,
    scope: 'organization',
    elevatedRequired: true,
  },
  'lead:list': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'lead:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'dashboard:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'workflow_run:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'incident:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'incident:manage': {
    roles: OPERATIONS_MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'report:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'approval:create': {
    roles: MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'approval:read': {
    roles: ALL_ROLES,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'approval:decide': {
    roles: APPROVAL_MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'approval:token_create': {
    roles: MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
  'approval:token_revoke': {
    roles: MANAGEMENT,
    scope: 'client',
    clientWideRoles: CLIENT_WIDE,
    elevatedRequired: true,
  },
};

export function can(actor: Actor, action: Action, scope: ResourceScope = {}): boolean {
  const entry: MatrixEntry | undefined = (MATRIX as Record<string, MatrixEntry | undefined>)[
    action
  ];
  if (!entry) return false;
  if (!(entry.roles as readonly string[]).includes(actor.role)) return false;

  if (entry.elevatedRequired && actor.role === 'platform_admin' && !actor.elevated) {
    return false;
  }

  if (entry.scope === 'platform') return true;

  if (scope.organizationId !== actor.organizationId) return false;

  if (entry.scope === 'organization') return true;

  // client scope
  if (entry.clientWideRoles && (entry.clientWideRoles as readonly string[]).includes(actor.role)) {
    return true;
  }
  if (!scope.clientId) return false;
  return (actor.assignedClientIds ?? []).includes(scope.clientId);
}

export function assertCan(actor: Actor, action: Action, scope: ResourceScope = {}): void {
  if (!can(actor, action, scope)) {
    throw new AuthorizationError(action);
  }
}
