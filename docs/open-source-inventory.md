# Open Source Inventory

LeadOps Portal relies on the following open-source projects.
Each entry records the project URL, fixed version/commit, license, usage, and whether modified.

## Runtime Dependencies

| Project                | URL                                         | Version | License                                  | Usage                                  | Modified |
| ---------------------- | ------------------------------------------- | ------- | ---------------------------------------- | -------------------------------------- | -------- |
| Next.js                | https://github.com/vercel/next.js           | ^15.3.0 | MIT                                      | Web application framework (App Router) | No       |
| React                  | https://github.com/facebook/react           | ^19.1.0 | MIT                                      | UI rendering library                   | No       |
| Lucide React           | https://github.com/lucide-icons/lucide      | ^1.28.0 | ISC (selected Feather-derived icons MIT) | Product interface icons                | No       |
| Drizzle ORM            | https://github.com/drizzle-team/drizzle-orm | ^0.45.2 | Apache-2.0                               | TypeScript ORM for PostgreSQL          | No       |
| postgres (Postgres.js) | https://github.com/porsager/postgres        | ^3.4.5  | MIT                                      | PostgreSQL client                      | No       |
| Zod                    | https://github.com/colinhacks/zod           | 3.24.2  | MIT                                      | Runtime schema validation              | No       |
| Pino                   | https://github.com/pinojs/pino              | ^9.7.0  | MIT                                      | Structured JSON logging                | No       |
| pino-pretty            | https://github.com/pinojs/pino-pretty       | ^13.1.0 | MIT                                      | Dev-friendly log formatting            | No       |

## Development Dependencies

| Project                | URL                                                    | Version | License    | Usage                              | Modified |
| ---------------------- | ------------------------------------------------------ | ------- | ---------- | ---------------------------------- | -------- |
| TypeScript             | https://github.com/microsoft/TypeScript                | ^5.9.0  | Apache-2.0 | Static type checking               | No       |
| ESLint                 | https://github.com/eslint/eslint                       | ^9.38.0 | MIT        | Code linting                       | No       |
| Prettier               | https://github.com/prettier/prettier                   | ^3.6.0  | MIT        | Code formatting                    | No       |
| Vitest                 | https://github.com/vitest-dev/vitest                   | ^3.2.0  | MIT        | Unit testing framework             | No       |
| tsx                    | https://github.com/privatenumber/tsx                   | ^4.19.0 | MIT        | TypeScript execution (worker dev)  | No       |
| Drizzle Kit            | https://github.com/drizzle-team/drizzle-orm            | ^0.31.0 | MIT        | Schema migrations                  | No       |
| typescript-eslint      | https://github.com/typescript-eslint/typescript-eslint | ^8.48.0 | MIT        | TypeScript-aware ESLint rules      | No       |
| eslint-config-prettier | https://github.com/prettier/eslint-config-prettier     | ^10.1.0 | MIT        | Disables ESLint/Prettier conflicts | No       |

## Infrastructure

| Project    | URL                                  | Version   | License    | Usage             | Modified |
| ---------- | ------------------------------------ | --------- | ---------- | ----------------- | -------- |
| PostgreSQL | https://github.com/postgres/postgres | 16-alpine | PostgreSQL | Primary database  | No       |
| Docker     | https://github.com/docker            | 29.x      | Apache-2.0 | Container runtime | No       |

## SaaS Starter Reference

| Project             | URL                                    | Commit                         | License | Usage                                                                        | Modified |
| ------------------- | -------------------------------------- | ------------------------------ | ------- | ---------------------------------------------------------------------------- | -------- |
| nextjs/saas-starter | https://github.com/nextjs/saas-starter | N/A (structure reference only) | MIT     | Reference for monorepo layout patterns; no code was copied into this project | N/A      |

## Frontend Pattern References

| Project | URL                                  | License status                  | Usage                                                               | Included |
| ------- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------- | -------- |
| Twenty  | https://github.com/twentyhq/twenty   | Source-available terms reviewed | Information-hierarchy research only; no code or assets copied       | No       |
| Dub     | https://github.com/dubinc/dub        | AGPL-3.0                        | Navigation and data-density research only; no code or assets copied | No       |
| Tremor  | https://github.com/tremorlabs/tremor | Apache-2.0                      | Dashboard pattern research only; no code or assets copied           | No       |

## Compliance Notes

- Dependencies are resolved from the pinned lockfile; dependency source code and `node_modules` are not vendored in this snapshot.
- The lockfile is predominantly MIT, ISC, Apache-2.0, BSD, 0BSD, and Unlicense, but it also contains BlueOak-1.0.0, Python-2.0, CC-BY-4.0, and package-specific dual or combined terms.
- The platform-specific Sharp binary reports `Apache-2.0 AND LGPL-3.0-or-later`; `caniuse-lite` reports CC-BY-4.0; `json-schema` and `type-fest` report alternative-license expressions.
- The research references above were not copied into the repository.
- CI uses a frozen lockfile and records a dependency license inventory. Before distribution or deployment, review the complete current output of `pnpm licenses list --prod --json` and `pnpm licenses list --dev --json`.
