import type postgres from 'postgres';

import type { OrganizationMemberRole } from '../schema/tenancy.js';

export interface TenantContext {
  userId: string;
  organizationId: string;
  role: OrganizationMemberRole;
  clientId?: string;
  invitationTokenHash?: string;
}

export interface IntegrationContext {
  integrationId: string;
  organizationId: string;
  clientId: string;
}

export type TenantTransaction = postgres.TransactionSql;

export async function withTenantContext<T>(
  pool: postgres.Sql,
  context: TenantContext,
  callback: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return pool.begin(async (tx) => {
    await tx.unsafe(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.organization_id', $2, true),
              set_config('app.role', $3, true),
              set_config('app.client_id', $4, true),
              set_config('app.invitation_token_hash', $5, true)`,
      [
        context.userId,
        context.organizationId,
        context.role,
        context.clientId ?? null,
        context.invitationTokenHash ?? null,
      ],
    );
    const result = await callback(tx);
    return result;
  }) as Promise<T>;
}

export async function withIntegrationContext<T>(
  pool: postgres.Sql,
  context: IntegrationContext,
  callback: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return pool.begin(async (tx) => {
    await tx.unsafe(
      `SELECT set_config('app.user_id', '', true),
              set_config('app.organization_id', $1, true),
              set_config('app.role', '', true),
              set_config('app.client_id', $2, true),
              set_config('app.invitation_token_hash', '', true),
              set_config('app.integration_id', $3, true)`,
      [
        context.organizationId,
        context.clientId,
        context.integrationId,
      ],
    );
    const result = await callback(tx);
    return result;
  }) as Promise<T>;
}
