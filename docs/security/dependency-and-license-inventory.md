# Dependency and License Inventory

## Project Overview

| Attribute          | Value                                          |
| ------------------ | ---------------------------------------------- |
| Package manager    | pnpm 11.18.0                                   |
| Workspace          | Monorepo (pnpm workspaces)                     |
| Node requirement   | >= 22                                          |
| pnpm requirement   | >= 9                                           |

### Workspace Packages

| Package                    | Name                       | Type     | Description                              |
| -------------------------- | -------------------------- | -------- | ---------------------------------------- |
| `apps/web`                 | `@leadops/web`             | App      | Next.js 15 web application               |
| `apps/worker`              | `@leadops/worker`          | App      | Background job worker (pg-boss)          |
| `packages/core`            | `@leadops/core`            | Library  | Shared business logic, tokens, validation |
| `packages/db`              | `@leadops/db`              | Library  | Database schema, services, tenancy       |
| `packages/email`           | `@leadops/email`           | Library  | Email templates (React Email)            |
| `packages/events`          | `@leadops/events`          | Library  | Webhook signing, validation, HMAC        |
| `packages/n8n`             | `@leadops/n8n`             | Library  | n8n workflow definitions                 |
| `packages/observability`   | `@leadops/observability`   | Library  | Logging (Pino), metrics, OpenTelemetry   |
| `packages/alert`           | `@leadops/alert`           | Library  | Alerting provider (webhook)              |

## Production Dependencies

### Core Framework & Runtime

| Package          | Version  | License      | Used By                |
| ---------------- | -------- | ------------ | ---------------------- |
| next             | 15.5.22  | MIT          | web                    |
| react            | 19.2.8   | MIT          | web, email             |
| react-dom        | 19.2.8   | MIT          | web, email             |
| typescript       | ^5.9.0   | Apache-2.0   | All (devDependency)    |

### Database & ORM

| Package          | Version  | License      | Used By    |
| ---------------- | -------- | ------------ | ---------- |
| drizzle-orm      | ^0.45.2  | Apache-2.0   | db         |
| drizzle-zod      | ^0.7.1   | Apache-2.0   | db         |
| drizzle-kit      | ^0.31.0  | MIT          | db (dev)   |
| postgres         | ^3.4.9   | Unlicense    | db, root   |
| pg-boss          | ^10.1.5  | MIT          | worker     |

### Authentication

| Package          | Version  | License      | Used By    |
| ---------------- | -------- | ------------ | ---------- |
| better-auth      | ^1.6.25  | MIT          | web        |

### AI / LLM

| Package              | Version  | License      | Used By    |
| -------------------- | -------- | ------------ | ---------- |
| ai                   | ^7.0.56  | Apache-2.0   | worker     |
| @ai-sdk/openai       | ^4.0.34  | Apache-2.0   | worker     |

### Observability

| Package                                       | Version   | License      | Used By        |
| --------------------------------------------- | --------- | ------------ | -------------- |
| pino                                          | ^9.7.0    | MIT          | web, worker, observability |
| pino-pretty                                   | ^13.1.0   | MIT          | web, worker, observability |
| @opentelemetry/api                            | ^1.9.1    | Apache-2.0   | observability  |
| @opentelemetry/sdk-node                       | ^0.221.0  | Apache-2.0   | observability  |
| @opentelemetry/sdk-metrics                    | ^2.10.0   | Apache-2.0   | observability  |
| @opentelemetry/sdk-trace-node                 | ^2.10.0   | Apache-2.0   | observability  |
| @opentelemetry/resources                      | ^2.10.0   | Apache-2.0   | observability  |
| @opentelemetry/semantic-conventions           | ^1.43.0   | Apache-2.0   | observability  |
| @opentelemetry/exporter-trace-otlp-http       | ^0.221.0  | Apache-2.0   | observability  |
| @opentelemetry/exporter-metrics-otlp-http     | ^0.221.0  | Apache-2.0   | observability  |
| @opentelemetry/instrumentation-http           | ^0.221.0  | Apache-2.0   | observability  |
| @opentelemetry/instrumentation-pg             | ^0.73.0   | Apache-2.0   | observability  |

### Webhooks & Events

| Package          | Version  | License      | Used By    |
| ---------------- | -------- | ------------ | ---------- |
| standardwebhooks | ^1.0.0   | MIT          | events     |

### Email

| Package                  | Version  | License      | Used By    |
| ------------------------ | -------- | ------------ | ---------- |
| @react-email/components  | ^1.0.12  | MIT          | email      |
| @react-email/render      | ^2.1.0   | MIT          | email      |

### Validation

| Package | Version  | License | Used By             |
| ------- | -------- | ------- | ------------------- |
| zod     | 3.24.2   | MIT     | core, db, events, web |

### UI

| Package       | Version  | License | Used By |
| ------------- | -------- | ------- | ------- |
| lucide-react  | ^1.28.0  | MIT     | web     |

### Dev Tooling (Root)

| Package                | Version   | License      | Type     |
| ---------------------- | --------- | ------------ | -------- |
| eslint                 | ^9.38.0   | MIT          | Linting  |
| @eslint/js             | ^9.38.0   | MIT          | Linting  |
| @next/eslint-plugin-next | 15.5.22 | MIT          | Linting  |
| eslint-config-prettier | ^10.1.0   | MIT          | Linting  |
| globals                | ^16.5.0   | MIT          | Linting  |
| typescript-eslint      | ^8.48.0   | MIT          | Linting  |
| prettier               | ^3.6.0    | MIT          | Format   |
| vitest                 | ^3.2.0    | MIT          | Testing  |
| @types/node            | ^22.19.0  | MIT          | Types    |
| tsx                    | ^4.19.0   | MIT          | Runner   |

## License Distribution Summary

| License                     | Package Count | Key Packages                                      | Risk Level |
| --------------------------- | ------------- | ------------------------------------------------- | ---------- |
| MIT                         | ~155          | next, react, better-auth, pino, zod, standardwebhooks, pg-boss, vitest | Low        |
| Apache-2.0                  | ~45           | drizzle-orm, ai, @ai-sdk/*, @opentelemetry/*, sharp | Low        |
| BSD-3-Clause                | ~13           | protobufjs, source-map-js, secure-json-parse     | Low        |
| BSD-2-Clause                | 4             | domelementtype, domhandler, domutils, entities   | Low        |
| Unlicense                   | 2             | postgres, fast-sha256                             | Low        |
| (AFL-2.1 OR BSD-3-Clause)   | 1             | json-schema                                       | Low        |
| 0BSD                        | 1             | tslib                                             | Low        |
| CC-BY-4.0                   | 1             | caniuse-lite                                      | Low        |

### License Compatibility Assessment

- **All licenses are permissive** (MIT, Apache-2.0, BSD, Unlicense, CC-BY-4.0)
- **No copyleft licenses** (GPL, LGPL, AGPL, MPL, EUPL) among production dependencies
- `@img/sharp-win32-x64` is licensed as `Apache-2.0 AND LGPL-3.0-or-later` — this is a native platform binary dependency, not a linked library; the LGPL component applies only to distribution of modified versions of the library itself

## Known Vulnerabilities Assessment

The Phase 6C verification ran `pnpm audit --prod --audit-level high` against
the official npm advisory endpoint. No critical or high vulnerabilities were
reported; one moderate advisory remains below the configured release gate.

### Vulnerability Monitoring Process

1. **Automated**: Run `pnpm audit --prod` as part of CI pipeline
2. **Manual**: Review npm advisory database weekly
3. **SBOM**: Generate SBOM for each release (see below)

### Remediation Policy

| Severity | Response Time | Action                                        |
| -------- | ------------- | --------------------------------------------- |
| Critical | 24 hours      | Immediate patch or workaround                 |
| High     | 72 hours      | Patch within 3 business days                  |
| Medium   | 7 days        | Patch in next scheduled release               |
| Low      | Next release  | Address in normal release cycle               |

## SBOM Generation

### Via pnpm (recommended)

Generate an SPDX-compliant SBOM from the pnpm lockfile:

```bash
# Install cyclonedx plugin
pnpm add -g @cyclonedx/cyclonedx-npm

# Generate SBOM for all workspaces (JSON)
pnpm cyclonedx-npm --output-file sbom.json --output-format JSON

# Generate SBOM for production only
pnpm cyclonedx-npm --output-file sbom.prod.json --output-format JSON --production-only

# Generate SBOM for a specific package
pnpm --filter @leadops/web cyclonedx-npm --output-file sbom.web.json --output-format JSON
```

### Via npm alternative

```bash
npm install -g @cyclonedx/cyclonedx-npm
cyclonedx-npm --output-file sbom.json --output-format JSON
```

### SBOM Format

SBOMs follow CycloneDX 1.4 specification. Each entry includes:

- Package name and version
- License identifier (SPDX)
- Package URL (purl)
- Dependency graph
- Hash values (SHA-256)

### Running a Vulnerability Scan on SBOM

```bash
# Generate SBOM
pnpm cyclonedx-npm --output-file sbom.json

# Scan with grype (requires grype installation)
grype sbom:sbom.json

# Scan with trivy (requires trivy installation)
trivy sbom sbom.json
```

## Dependency Update Cadence

| Activity               | Frequency       | Tool                |
| ---------------------- | --------------- | ------------------- |
| Security audit         | Per CI run      | `pnpm audit --prod` |
| Minor/patch updates    | Weekly          | `pnpm update`       |
| Major version review   | Monthly         | Manual review       |
| License audit          | Per release     | `pnpm licenses list --prod` |
| SBOM generation        | Per release     | cyclonedx-npm       |
| Lockfile integrity     | Per CI run      | `pnpm install --frozen-lockfile` |
