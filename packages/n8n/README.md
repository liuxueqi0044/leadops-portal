# LeadOps n8n integration pack

This package targets the pinned acceptance image `n8nio/n8n:1.106.3`. It contains four inactive, importable reference workflows. Customers own their n8n instance and all CRM, calendar, email, and AI credentials; LeadOps stores only the integration callback URL and its encrypted business-event secret.

## Import

1. Register an integration in LeadOps and copy the secret shown once.
2. Configure the variables documented in `.env.example` in the n8n runtime. Never paste the secret into a workflow node or pin data.
3. Allow the Code node to use only Node's `crypto` built-in (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`).
4. Import in this order: `emit-business-event.json`, `global-error-handler.json`, `request-human-approval.json`, then `lead-qualification-main.json`.
5. Verify each Execute Workflow node resolves the imported workflow ID shown in its configuration. The JSON uses stable IDs beginning with `leadops-`.
6. Replace the clearly named AI and CRM/Calendar/Email adapter boundaries with customer-owned nodes and credentials. Preserve the input/output fields and error routing.
7. Register the production webhook URL for `leadops-approval-callback` as the integration callback URL, then activate the callback and main workflows.

The approval branch is asynchronous: the initial execution creates the approval and returns. A separate callback webhook receives the later terminal decision. It does not keep an execution waiting for a human.

## Security and operations

- Business events and approval creation use Standard Webhooks-style HMAC headers and stable webhook IDs. Built-in HTTP retry reuses the same signed item.
- The approval callback verifies the HMAC and a five-minute timestamp window before reaching adapter nodes.
- Workflow settings disable successful/error execution-data persistence. Error events contain only a short classification, never the secret, authorization headers, or full lead form.
- Do not expose n8n directly without TLS and access controls. The LeadOps callback registration rejects private, metadata, redirect, and DNS-rebinding targets.
- The sample AI boundary deliberately falls back to `needs_review` unless a strict structured adapter result is supplied; it never auto-runs a high-risk action on invalid output.

## Verification and rollback

Run `node acceptance/n8n-import.mjs` from the repository root. It imports all four files into a clean temporary n8n data volume using the pinned image, lists the imported IDs, and deletes the volume.

Use the files in `fixtures/` to test high-score, manual-decision, callback, and safe-failure paths. To roll back, deactivate the two public webhook workflows first, restore the previous exported workflow versions, verify the workflow-ID references, and reactivate them. Portal deliveries remain retryable and are not converted into new business decisions by this operation.
