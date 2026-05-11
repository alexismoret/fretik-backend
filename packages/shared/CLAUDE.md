# @fretik/shared

Core package: DB schema, relations, services, libs. All other backend packages import from here via subpath exports — never reach into `src/` directly.

## Conventions

- **Drizzle v2 relations only.** `defineRelations()` with `from`/`to` in `src/db/relations.ts`. Do NOT use v1 `fields`/`references` — it compiles but breaks the query system.
- **Prefer `db.query.*.findFirst/findMany` with `with:`** over the builder. The builder is fine for batch ops (`inArray()` for INSERT/UPDATE/DELETE) but not for reads with relations.
- **Services = one file per operation.** `services/{domain}/` holds `upload.ts`, `delete.ts`, `retrieve.ts`, etc. Each exports a function. No class monoliths, no `index.ts` that re-exports everything.
- **Every new export must be wired in `package.json` `exports`.** Consumers import `@fretik/shared/services/documents/upload`, not a relative path. If it's not in `exports`, it doesn't exist.
- **Migration lock.** `db:migrate` holds a PG advisory lock — safe to run concurrently, only one wins. Don't add your own locking on top.

## Pattern reference

When adding a new service operation, mirror `src/services/documents/upload.ts` — Zod validation at the boundary, `throwHttpError()` for TS narrowing, explicit `await` on everything, fire-and-forget only when intentional (e.g., `wakeWaitingDocumentExecutions`).

## Gotchas

- `db/index.ts` must import `./schema` BEFORE `./relations` — relations reference tables, so the import order is load-bearing.
- Fire-and-forget promises look fine locally but get orphaned when the process exits — always `await` unless explicitly documented as fire-and-forget.
- `auth.ts` in `lib/` is imported by both API and worker — changing session shape requires coordinating both sides.
- `db:push` is dev-only. Any schema change that ships needs `db:generate` + commit the migration file.
