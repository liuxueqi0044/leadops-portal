/** Fixed internal roles. client_approver does not exist; there is no seventh role. */
export const ROLES = [
  'platform_admin',
  'agency_owner',
  'agency_admin',
  'agency_operator',
  'client_admin',
  'client_viewer',
] as const;

export type Role = (typeof ROLES)[number];

export const ORG_LEVEL_ROLES: readonly Role[] = [
  'agency_owner',
  'agency_admin',
  'agency_operator',
];

export const CLIENT_LEVEL_ROLES: readonly Role[] = ['client_admin', 'client_viewer'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
