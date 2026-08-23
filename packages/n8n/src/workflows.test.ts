import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  n8nWorkflowSchema,
  type N8nWorkflow,
  type N8nNode,
} from "./schema.js";

const WORKFLOW_DIR = resolve(__dirname, "..");

function loadAndValidateWorkflow(filename: string): N8nWorkflow {
  const content = readFileSync(resolve(WORKFLOW_DIR, filename), "utf-8");
  const raw = JSON.parse(content) as unknown;
  return n8nWorkflowSchema.parse(raw);
}

describe("n8n workflow JSON validation", () => {
  const workflowFiles = [
    "lead-qualification-main.json",
    "emit-business-event.json",
    "request-human-approval.json",
    "global-error-handler.json",
  ];

  const loaded = new Map<string, N8nWorkflow>();

  for (const filename of workflowFiles) {
    describe(filename, () => {
      let wf: N8nWorkflow;

      beforeAll(() => {
        wf = loadAndValidateWorkflow(filename);
        loaded.set(filename, wf);
      });

      it("passes Zod schema validation", () => {
        expect(wf.name).toBeTruthy();
        expect(wf.nodes.length).toBeGreaterThan(0);
        expect(wf.connections).toBeDefined();
      });

      it("every node has required fields with correct position type", () => {
        for (const node of wf.nodes) {
          expect(node.id).toBeTruthy();
          expect(node.name).toBeTruthy();
          expect(node.type).toBeTruthy();
          expect(node.type).toMatch(/^n8n-nodes-base\./);
          expect(Array.isArray(node.position)).toBe(true);
          expect(node.position.length).toBe(2);
          expect(typeof node.position[0]).toBe("number");
          expect(typeof node.position[1]).toBe("number");
        }
      });

      it("connection keys reference valid node names", () => {
        const nodeNames = new Set(wf.nodes.map((n: N8nNode) => n.name));
        for (const [sourceNodeName, connection] of Object.entries(wf.connections)) {
          expect(nodeNames.has(sourceNodeName)).toBe(true);
          const main = (connection as { main?: { node?: string }[][] }).main ?? [];
          for (const output of main) {
            for (const target of output) expect(nodeNames.has(String(target.node))).toBe(true);
          }
        }
      });

      it("does not persist execution data or contain credential literals", () => {
        expect(wf.settings).toMatchObject({
          saveDataSuccessExecution: "none",
          saveDataErrorExecution: "none",
          executionProgress: false,
        });
        const serialized = JSON.stringify(wf);
        expect(serialized).not.toMatch(/SESSION_COOKIE|Authorization:|signedPayload/);
        expect(serialized).not.toMatch(/whsec_[A-Za-z0-9+/=]{16,}/);
      });
    });
  }

  describe("lead-qualification-main.json specific", () => {
    it("has webhook trigger node", () => {
      const wf = loaded.get("lead-qualification-main.json");
      if (!wf) throw new Error("workflow not loaded");
      const webhook = wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook");
      expect(webhook).toBeDefined();
    });

    it("has validation, stable dedupe, and strict AI fallback nodes", () => {
      const wf = loaded.get("lead-qualification-main.json");
      if (!wf) throw new Error("workflow not loaded");
      const validateNode = wf.nodes.find((n) => n.id === "validate-normalize");
      expect(validateNode).toBeDefined();
      const dedupe = wf.nodes.find((n) => n.id === "dedupe-key");
      const ai = wf.nodes.find((n) => n.id === "ai-qualification");
      expect(String(dedupe?.parameters?.jsCode)).toContain("dedupeKey");
      expect(String(ai?.parameters?.jsCode)).toContain("needs_review");
      expect(String(ai?.parameters?.jsCode)).not.toContain("Math.random");
    });
  });

  describe("emit-business-event.json specific", () => {
    it("has signing node", () => {
      const wf = loaded.get("emit-business-event.json");
      if (!wf) throw new Error("workflow not loaded");
      const signNode = wf.nodes.find((n) => n.id === "sign-event");
      expect(signNode).toBeDefined();
    });

    it("sends the exact raw signed body and retries with the same item", () => {
      const wf = loaded.get("emit-business-event.json");
      if (!wf) throw new Error("workflow not loaded");
      const sendNode = wf.nodes.find((n) => n.id === "send-event");
      expect(sendNode?.parameters).toMatchObject({
        sendBody: true,
        contentType: "raw",
        body: "={{ $json.rawBody }}",
      });
      expect(sendNode?.retryOnFail).toBe(true);
      expect(sendNode?.maxTries).toBe(3);
      expect(String(wf.nodes.find((n) => n.id === "sign-event")?.parameters?.jsCode))
        .not.toContain("signedPayload");
    });

    it("is an executable sub-workflow", () => {
      const wf = loaded.get("emit-business-event.json");
      expect(wf?.nodes.some((node) => node.type === "n8n-nodes-base.executeWorkflowTrigger"))
        .toBe(true);
    });
  });

  describe("request-human-approval.json specific", () => {
    it("uses a separate asynchronous callback webhook", () => {
      const wf = loaded.get("request-human-approval.json");
      if (!wf) throw new Error("workflow not loaded");
      const callbackWebhook = wf.nodes.find((n) => n.id === "callback-webhook");
      expect(callbackWebhook).toBeDefined();
      if (callbackWebhook) {
        expect(callbackWebhook.type).toBe("n8n-nodes-base.webhook");
      }
      expect(wf.nodes.some((node) => node.id === "subworkflow-trigger")).toBe(true);
      expect(wf.nodes.some((node) => node.id === "verify-callback")).toBe(true);
    });

    it("has CRM/Calendar/Email adapter stubs", () => {
      const wf = loaded.get("request-human-approval.json");
      if (!wf) throw new Error("workflow not loaded");
      const processNode = wf.nodes.find((n) => n.id === "process-result");
      expect(processNode).toBeDefined();
    });

    it("uses the current signed approval DTO without putting tenant IDs in snapshot", () => {
      const wf = loaded.get("request-human-approval.json");
      const code = String(wf?.nodes.find((node) => node.id === "build-request")?.parameters?.jsCode);
      expect(code).toContain("clientId: $env.LEADOPS_CLIENT_ID");
      expect(code).toContain("integrationId: $env.LEADOPS_INTEGRATION_ID");
      const snapshotCode = code.slice(code.indexOf("snapshot:"), code.indexOf("expiresInSeconds"));
      expect(snapshotCode).not.toContain("clientId:");
      expect(code).not.toContain("SESSION_COOKIE");
    });
  });

  describe("global-error-handler.json specific", () => {
    it("categorizes errors without logging secrets", () => {
      const wf = loaded.get("global-error-handler.json");
      if (!wf) throw new Error("workflow not loaded");
      const normalizeNode = wf.nodes.find((n) => n.id === "normalize-error");
      expect(normalizeNode).toBeDefined();

      const params = normalizeNode?.parameters;
      const jsCode = params?.jsCode as string | undefined;
      expect(jsCode).toBeTruthy();
      if (jsCode) {
        expect(jsCode).toContain("substring");
        expect(jsCode).toContain("500");
        // Must not reference env credentials in execution output
        expect(jsCode).not.toContain("$env.API_KEY");
        expect(jsCode).not.toContain("$env.WEBHOOK_SECRET");
      }
    });

    it("has classification nodes for all error types", () => {
      const wf = loaded.get("global-error-handler.json");
      if (!wf) throw new Error("workflow not loaded");
      const classifiers = wf.nodes.filter((n) =>
        n.id.startsWith("check-") || n.id.startsWith("handle-"),
      );
      expect(classifiers.length).toBeGreaterThanOrEqual(4);
    });

    it("is a sub-workflow and emits only a sanitized failure event", () => {
      const wf = loaded.get("global-error-handler.json");
      expect(wf?.nodes.some((node) => node.type === "n8n-nodes-base.executeWorkflowTrigger"))
        .toBe(true);
      const safeEvent = String(wf?.nodes.find((node) => node.id === "build-failure-event")?.parameters?.jsCode);
      expect(safeEvent).toContain("workflow.run.failed");
      expect(safeEvent).not.toMatch(/requestBody|authorization|secret/i);
    });
  });
});
