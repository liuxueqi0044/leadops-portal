import type postgres from "postgres";
import { generateWebhookSecret } from "@leadops/events";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { notFound, conflict, invalid } from "./errors.js";

export interface IntegrationRow {
  id: string;
  organizationId: string;
  clientId: string;
  name: string;
  status: string;
  callbackUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createIntegration(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    clientId: string;
    name: string;
    callbackUrl?: string | null;
  },
): Promise<{ integration: IntegrationRow; secret: string }> {
  const existing = await sql`
    SELECT id FROM integrations
    WHERE "organizationId" = ${params.organizationId}
      AND "clientId" = ${params.clientId}
      AND name = ${params.name}
  `;
  if (existing.length > 0) {
    throw conflict("Integration with this name already exists for this client");
  }

  const { prefixSecret } = generateWebhookSecret();
  const encrypted = encryptSecret(prefixSecret);

  await sql`
    WITH new_integration AS (
      INSERT INTO integrations ("organizationId", "clientId", name, callback_url)
      VALUES (${params.organizationId}, ${params.clientId}, ${params.name}, ${params.callbackUrl ?? null})
      RETURNING id, "organizationId"
    )
    INSERT INTO integration_secrets ("integrationId", "organizationId", version, encrypted_secret)
    SELECT id, "organizationId", 1, ${encrypted}
    FROM new_integration
  `;

  const [integration] = await sql`
    SELECT id, "organizationId", "clientId", name, status,
           callback_url AS "callbackUrl", "createdAt", "updatedAt"
    FROM integrations
    WHERE "organizationId" = ${params.organizationId}
      AND "clientId" = ${params.clientId}
      AND name = ${params.name}
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;

  return {
    integration: integration as IntegrationRow,
    secret: prefixSecret,
  };
}

export async function getIntegration(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
  },
): Promise<IntegrationRow | null> {
  const rows = await sql`
    SELECT id, "organizationId", "clientId", name, status,
           callback_url AS "callbackUrl", "createdAt", "updatedAt"
    FROM integrations
    WHERE id = ${params.integrationId}
      AND "organizationId" = ${params.organizationId}
  `;
  const row = rows[0];
  return row ? (row as IntegrationRow) : null;
}

export async function getIntegrationForVerification(
  sql: postgres.Sql,
  integrationId: string,
): Promise<{ integration: IntegrationRow; secrets: string[] } | null> {
  // Use SECURITY DEFINER function that bypasses RLS to locate the integration
  // and its active secrets before tenant context is established.
  const rows = await sql`
    SELECT * FROM lookup_integration_for_verification(${integrationId}::uuid)
  `;

  if (rows.length === 0) return null;
  const row = rows[0] as { id: string; organizationId: string; clientId: string; name: string; status: string; secrets: string[] };

  const secrets = row.secrets.map((s) => decryptSecret(s));

  return {
    integration: {
      id: row.id,
      organizationId: row.organizationId,
      clientId: row.clientId,
      name: row.name,
      status: row.status,
      callbackUrl: null,
      createdAt: "",
      updatedAt: "",
    },
    secrets,
  };
}

export async function rotateIntegrationSecret(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
  },
): Promise<{ integration: IntegrationRow; newSecret: string }> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.integrationId}, 0))`;
  const integration = await getIntegration(sql, params);
  if (!integration) throw notFound("Integration not found");

  if (integration.status === "revoked") {
    throw invalid("Cannot rotate secret for a revoked integration");
  }

  const [maxRow] = await sql`
    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
    FROM integration_secrets
    WHERE "integrationId" = ${params.integrationId}
  `;
  const nextVersion = (maxRow as { next_version: number }).next_version;

  const { prefixSecret } = generateWebhookSecret();
  const encrypted = encryptSecret(prefixSecret);

  await sql`
    INSERT INTO integration_secrets ("integrationId", "organizationId", version, encrypted_secret)
    VALUES (${params.integrationId}, ${params.organizationId}, ${nextVersion}, ${encrypted})
  `;

  await sql`
    UPDATE integration_secrets
    SET "revokedAt" = now()
    WHERE "integrationId" = ${params.integrationId}
      AND "revokedAt" IS NULL
      AND version != ${nextVersion}
  `;

  return { integration, newSecret: prefixSecret };
}

export async function revokeIntegration(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
  },
): Promise<IntegrationRow> {
  const integration = await getIntegration(sql, params);
  if (!integration) throw notFound("Integration not found");

  const [updated] = await sql`
    UPDATE integrations
    SET status = 'revoked', "updatedAt" = now()
    WHERE id = ${params.integrationId}
      AND "organizationId" = ${params.organizationId}
    RETURNING *
  `;

  await sql`
    UPDATE integration_secrets
    SET "revokedAt" = now()
    WHERE "integrationId" = ${params.integrationId}
      AND "revokedAt" IS NULL
  `;

  return updated as IntegrationRow;
}

export async function listIntegrations(
  sql: postgres.Sql,
  organizationId: string,
): Promise<IntegrationRow[]> {
  const rows = await sql`
    SELECT id, "organizationId", "clientId", name, status,
           callback_url AS "callbackUrl", "createdAt", "updatedAt"
    FROM integrations
    WHERE "organizationId" = ${organizationId}
    ORDER BY "createdAt" DESC
  `;
  return rows as unknown as IntegrationRow[];
}

export async function configureIntegrationCallback(
  sql: postgres.Sql,
  params: {
    organizationId: string;
    integrationId: string;
    callbackUrl: string;
  },
): Promise<IntegrationRow> {
  const rows = await sql`
    UPDATE integrations
    SET callback_url = ${params.callbackUrl}, "updatedAt" = now()
    WHERE id = ${params.integrationId}
      AND "organizationId" = ${params.organizationId}
      AND status = 'active'
    RETURNING id, "organizationId", "clientId", name, status,
              callback_url AS "callbackUrl", "createdAt", "updatedAt"
  `;
  const row = rows[0];
  if (!row) throw notFound('Integration not found');
  return row as IntegrationRow;
}
