# ADR 001: pnpm Workspace Monorepo Structure

**Date**: 2026-08-02  
**Status**: Accepted  
**Decision**: Use pnpm workspace with modular monolith structure for LeadOps Portal.

## Context

LeadOps Portal is a multi-tenant SaaS application with two deployable processes (web, worker) and multiple shared packages. We need a repository structure that:

- Enables independent development and testing of concern-isolated packages.
- Supports shared TypeScript config, linting, and formatting.
- Allows both processes to share domain logic, database access, and event schemas.
- Avoids early microservice complexity while keeping deployment flexibility.

## Decision

We use a pnpm workspace with the following layout:

```
apps/web        — Next.js App Router (pages, API routes)
apps/worker     — Independent Node.js process (background jobs)
packages/db     — Drizzle ORM schemas, migrations, queries
packages/core   — Pure domain logic, permissions, state machines
packages/events — Event schemas, webhook signing, idempotency
packages/email  — React Email templates and send adapter
packages/n8n    — n8n JSON templates, sample payloads, integration docs
```

## Alternatives Considered

### Nx / Turborepo
Rejected for MVP. pnpm workspace filtering (`pnpm -r`) provides sufficient task orchestration. Can adopt Turborepo later if build caching becomes necessary.

### npm / yarn workspaces
pnpm chosen for strict dependency resolution, disk efficiency, and built-in workspace protocol (`workspace:*`).

### Separate repositories
Rejected. Early-stage velocity suffers from cross-repo coordination. Monorepo keeps PRs atomic and versioning simple.

## Consequences

- All packages share a single `pnpm-lock.yaml`.
- CI uses `--frozen-lockfile` to ensure reproducibility.
- Packages reference each other via `workspace:*` protocol.
- Build order is resolved by pnpm automatically based on dependency graph.
