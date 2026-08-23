# syntax=docker/dockerfile:1
# Phase 6C — Multi-stage Dockerfile for Production Build
# Build targets: base, builder, web, worker, migration
# Non-root user, minimal image, no devDependencies or .env in image

# ---------------------------------------------------------------------------
# Stage 1: Base — shared runtime dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY tsconfig.base.json tsconfig.json tsconfig.root.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/alert/package.json packages/alert/package.json

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2: Builder — build application
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV LEADOPS_STANDALONE_BUILD=true
RUN corepack enable && corepack prepare pnpm@11 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3: Web — production web server
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 leadops && adduser -u 1001 -G leadops -s /bin/sh -D leadops

WORKDIR /app
COPY --from=builder --chown=leadops:leadops /app/apps/web/.next/standalone ./
COPY --from=builder --chown=leadops:leadops /app/apps/web/.next/static ./apps/web/.next/static

USER leadops
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# Stage 4: Worker — background job processor
# ---------------------------------------------------------------------------
FROM node:22-alpine AS worker
ENV NODE_ENV=production

RUN addgroup -g 1001 leadops && adduser -u 1001 -G leadops -s /bin/sh -D leadops

WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig*.json ./

USER leadops
CMD ["node", "apps/worker/dist/index.js"]

# ---------------------------------------------------------------------------
# Stage 5: Migration — database migration runner
# ---------------------------------------------------------------------------
FROM node:22-alpine AS migration
ENV NODE_ENV=production

RUN addgroup -g 1001 leadops && adduser -u 1001 -G leadops -s /bin/sh -D leadops

WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/migrations ./packages/db/migrations
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json

USER leadops
CMD ["node", "packages/db/dist/migrate-cli.js"]
