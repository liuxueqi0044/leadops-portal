import type { Action } from './actions.js';
import type { Role } from './roles.js';

/**
 * What the caller wants to act on. organizationId always refers to the
 * actor's own organization; clientId is a client within it. platform_admin
 * may act on a target organization only through explicit, audited elevation
 * (scope.elevated === true), never globally.
 */
export interface ResourceScope {
  organizationId?: string;
  clientId?: string;
  elevated?: boolean;
}

/**
 * Authenticated caller derived from a validated session. The role and
 * organization are re-queried from organization_members on every request;
 * values cached in cookies are never trusted.
 */
export interface Actor {
  userId: string;
  organizationId: string;
  role: Role;
  /** Clients the actor may access without being owner/admin: agency_operator
   *  assignments and client_admin/client_viewer client memberships. */
  assignedClientIds?: string[];
  /** True only when this actor came from the audited platform elevation flow. */
  elevated?: boolean;
}

export class AuthorizationError extends Error {
  public readonly code = 'FORBIDDEN';

  constructor(public readonly action: Action) {
    super(`Forbidden: actor cannot perform ${action}`);
    this.name = 'AuthorizationError';
  }
}
