import { describe, it, expect, beforeAll, afterAll } from "vitest";
/* eslint-disable @typescript-eslint/await-thenable */
import { createFixtureHandle, resetSchema, seedTenancyFixture } from "../test/fixtures.js";
import {
  createIntegration,
  rotateIntegrationSecret,
  revokeIntegration,
  listIntegrations,
  getIntegrationForVerification,
} from "../services/integrations.js";
import { decryptSecret } from "../services/crypto.js";
import { withTenantContext } from "../tenancy/context.js";
import type postgres from "postgres";

describe("Integration Services", () => {
  let handle: Awaited<ReturnType<typeof createFixtureHandle>>;
  let ownerAActor: { userId: string; organizationId: string; role: "agency_owner" };
  let clientA1Id: string;
  let clientA2Id: string;

  beforeAll(async () => {
    handle = await createFixtureHandle();
    await resetSchema(handle);
    const fixture = await seedTenancyFixture(handle);
    ownerAActor = {
      userId: fixture.users.ownerA.id,
      organizationId: fixture.orgA.id,
      role: "agency_owner" as const,
    };
    clientA1Id = fixture.clients.a1.id;
    clientA2Id = fixture.clients.a2.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("creates an integration with encrypted secret", async () => {
    const result = await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return createIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        clientId: clientA1Id,
        name: "Test Integration",
      });
    });

    expect(result.integration).toBeDefined();
    expect(result.integration.name).toBe("Test Integration");
    expect(result.integration.status).toBe("active");
    expect(result.secret).toMatch(/^whsec_/);

    const secretRows = await handle.owner.unsafe(
      `SELECT encrypted_secret FROM integration_secrets WHERE "integrationId" = $1`,
      [result.integration.id],
    );
    expect(secretRows).toHaveLength(1);
    const encrypted = ((secretRows[0] as unknown) as { encrypted_secret: string }).encrypted_secret;
    expect(encrypted).not.toBe(result.secret);
    expect(encrypted).toBeTruthy();

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(result.secret);
  });

  it("rejects duplicate integration name for same client", async () => {
    await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return createIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        clientId: clientA1Id,
        name: "Dup Integration",
      });
    });

    await expect(
      withTenantContext(handle.app, ownerAActor, async (tx) => {
        return createIntegration(tx as unknown as postgres.Sql, {
          organizationId: ownerAActor.organizationId,
          clientId: clientA1Id,
          name: "Dup Integration",
        });
      }),
    ).rejects.toThrow();
  });

  it("rotates secret and new secret works", async () => {
    const created = await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return createIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        clientId: clientA1Id,
        name: "Rotate Test",
      });
    });

    const before = await handle.owner.unsafe(
      `SELECT COUNT(*) as cnt FROM integration_secrets WHERE "integrationId" = $1 AND "revokedAt" IS NULL`,
      [created.integration.id],
    );
    expect(Number(((before[0] as unknown) as { cnt: string }).cnt)).toBe(1);

    const rotated = await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return rotateIntegrationSecret(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        integrationId: created.integration.id,
      });
    });

    expect(rotated.newSecret).toMatch(/^whsec_/);
    expect(rotated.newSecret).not.toBe(created.secret);

    const after = await handle.owner.unsafe(
      `SELECT COUNT(*) as cnt FROM integration_secrets WHERE "integrationId" = $1 AND "revokedAt" IS NULL`,
      [created.integration.id],
    );
    expect(Number(((after[0] as unknown) as { cnt: string }).cnt)).toBe(1);

    const verifyResult = await getIntegrationForVerification(handle.app, created.integration.id);
    expect(verifyResult).toBeDefined();
    expect(verifyResult!.secrets.length).toBeGreaterThanOrEqual(1);
  });

  it("revoked integration returns null for verification", async () => {
    const created = await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return createIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        clientId: clientA1Id,
        name: "Revoke Test",
      });
    });

    await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return revokeIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        integrationId: created.integration.id,
      });
    });

    const verifyResult = await getIntegrationForVerification(handle.app, created.integration.id);
    expect(verifyResult).toBeNull();
  });

  it("lists integrations scoped to organization", async () => {
    await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return createIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        clientId: clientA1Id,
        name: "List Test 1",
      });
    });

    await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return createIntegration(tx as unknown as postgres.Sql, {
        organizationId: ownerAActor.organizationId,
        clientId: clientA2Id,
        name: "List Test 2",
      });
    });

    const list = await withTenantContext(handle.app, ownerAActor, async (tx) => {
      return listIntegrations(tx as unknown as postgres.Sql, ownerAActor.organizationId);
    });

    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
