// @leadops/core — Pure domain logic, permissions, and state machines.
// This package must not depend on Next.js, React, SQLite, specific email providers, or AI SDKs.

export const CORE_VERSION = '0.0.0';

export * from './authorization/index.js';
export * from './dto/index.js';
export * from './leads/index.js';
export * from './approval/index.js';
export * from './incidents/index.js';
export * from './reports/index.js';
export * from './workflows/index.js';
export * from './config/production.js';
