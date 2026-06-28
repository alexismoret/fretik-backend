# `shared` ops scripts & the objects data-migration runbook

One-off / maintenance scripts run ad-hoc with `bun --env-file=../../.env run src/scripts/<name>.ts`
(from `backend/packages/shared`). They are **not** part of `bun run check` or the
migration chain — schema migrations live in `drizzle/` and apply automatically at
boot (`db/index.ts` → `runMigrationsWithLock`, advisory-locked).

## Script inventory

| Script                                         | Status                  | Purpose                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reseed-system-ontology.ts`                    | **keep**                | Seed system + starter object types for every org, propagate org-scope field defs to every team. Idempotent. The dev **re-seed** primitive.                                                                                    |
| `sync-object-tables.ts`                        | **keep**                | Reconcile every team's `data.obj_*` extension tables to their field defs + (re)arm RLS. The existing-tenant **provisioning / backfill / repair** primitive (was `sync-typed-views.ts` — renamed; there are no views anymore). |
| `check-objects-rls.ts`                         | **keep**                | Deterministic RLS/grant verification (see below). Run after migrate + seed.                                                                                                                                                   |
| `build-icon-catalog.ts` + `icon-essentials.ts` | **keep**                | Regenerate the curated Lucide icon catalog (backend `lib/icons/catalog.ts` **and** the frontend mirror `app/.../objectIconCatalog.json`).                                                                                     |
| `grant-super-admin.ts`                         | **keep**                | Admin utility — unrelated to objects.                                                                                                                                                                                         |
| `smoke-phase2-fold.ts`                         | **keep (manual smoke)** | Drives the document→graph fold + domain-events outbox + attribute history against the dev DB and asserts invariants, then cleans up. Still exercises live services (the fold survived the refonte); run it as a manual smoke. |

Removed one-off dev migrations (moot after dev wipe-and-reseed + empty prod — a
fresh `CREATE TABLE` already produces the target schema):

- `regenerate-starter-ontology.ts` (P7 audit) — fixed starter field defs on orgs
  seeded before the new field types existed.
- `migrate-system-columns.ts` — renamed bare → underscore-prefixed system columns
  (`label`→`_label`, …); the DDL engine now creates them underscore-prefixed.
- `backfill-record-timestamps.ts` — added + backfilled `created_at`/`updated_at`
  on pre-existing typed tables; they are now in the `CREATE TABLE`.

## The objects data-migration / provisioning model

The typed-table refonte replaces the JSONB `object_records.data` column with one
real `data.obj_<typeId-hex>` table per object type (the DDL engine in
`services/object-schema/`). Two things must be true on any environment: the
schema migration is applied, and **every (org, team)'s per-type tables exist and
are RLS-armed**.

### Provisioning is automatic for go-forward tenants

The DDL engine is wired into every catalog write path, so new tenants never need
a backfill:

- **Org create** (`lib/auth.ts` hook) → `seedSystemOntology` + `seedStarterObjectTypes`
  → each `createObjectType*` calls `reconcileObjectTable` (creates + arms the table).
- **Team create** (`lib/auth.ts` hook) → `duplicateOrgDefsToTeam` → `syncAllObjectTablesForTeam`.
- **Type/field create/update/delete** → `reconcileObjectTable` / `changeFieldColumns`
  / `dropObjectTable`, each re-arming security.

`armTableSecurity` (in `services/object-schema/table.ts`) is the single arming
point: `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY sql_tool_read` (team OR
`fretik_type_granted` OR `fretik_record_shared`) + `GRANT SELECT` to
`fretik_sql_tool`. The `data` schema, the `fretik_*` helper functions, the grant
tables, and the sharing-aware registry/catalog policies are created **once** by
the `silent_obadiah_stane` migration (global to the SaaS).

### Dev: wipe & re-seed (chosen)

1. Drop/recreate the database (or `DROP SCHEMA public CASCADE; DROP SCHEMA data CASCADE;`).
2. Boot a backend service (or `bun run db:migrate`) — applies all migrations,
   including `silent_obadiah_stane` (creates `data` schema, helpers, grant tables;
   drops the legacy JSONB `data` column).
3. `bun run src/scripts/reseed-system-ontology.ts` — seeds system + starter types
   per org and propagates org defs to teams. Tables + RLS are provisioned by the
   engine during seeding.
4. `bun run src/scripts/sync-object-tables.ts` — belt-and-suspenders backfill (no-op
   if seeding already provisioned everything).
5. `bun run src/scripts/check-objects-rls.ts` — verify (below).

### Production deployment runbook — existing orgs & teams

Prod has existing orgs/teams (and possibly existing `object_records`). The
`silent_obadiah_stane` migration **drops the JSONB `object_records.data` column**
(`DROP COLUMN data CASCADE`) — a clean break that assumes prod holds no object
_field values_ worth keeping. Validate that first, then provision the typed
tables + default types for every existing tenant, then make the AI schema-aware.

Run the ordered steps below **once** per environment.

#### 0. Before deploying the new image (the old `data` column still exists)

- **Full backup:** `pg_dump` the prod DB. The column drop is destructive and there
  is **no down-migration** — rollback = restore this dump.
- **Check for object field values that the migration would destroy:**
  ```sql
  SELECT count(*) FROM object_records WHERE data IS NOT NULL AND data <> '{}'::jsonb;
  ```
  - `0` → clean break is safe. Continue.
  - `> 0` → those typed values **will be lost** on deploy. Either accept it (records
    keep their `label`; values are re-populated as users/the agent edit them, and
    document-mirror records refill when their document is re-processed), **or** write
    and run a one-off `export jsonb → data.obj_* INSERT` migration _before_ deploying.
    That data-preserving path is **not built** (the refonte assumed an empty prod).

#### 1. Deploy

Ship the image. At container start `runMigrationsWithLock` (advisory-locked,
multi-replica-safe) applies `silent_obadiah_stane`: creates the `data` schema,
the `fretik_*` RLS helpers, `object_grants` / `record_shares`, and the
sharing-aware registry/catalog policies; drops the JSONB `data` column, the `v_*`
views, and `fretik_text_to_date`.

#### 2. Roles & env (one-time, required before the AI touches objects)

- `fretik_sql_tool` least-privilege role with LOGIN + password (from the
  `harden_sql_tool` migration): `ALTER ROLE fretik_sql_tool LOGIN PASSWORD '…';`
  The refonte migration already `GRANT USAGE ON SCHEMA data` to it; the DDL engine
  grants `SELECT` per `data.obj_*` table.
- Env present on API + AI: `DATABASE_URL`, `REDIS_URL`, `AI_DB_READONLY_URL`
  (→ the `fretik_sql_tool` role). AI also needs `E2B_API_KEY`,
  `SANDBOX_JWT_SECRET`, `FRETIK_BACKEND_INTERNAL_URL` (the code-mode `objects` SDK
  - per-turn JWT).

#### 3. One-shot backfill for existing tenants (run once, in this order)

New orgs/teams self-provision via the auth hooks; existing ones need this:

```
bun --env-file=<env> run src/scripts/reseed-system-ontology.ts   # default types per org + propagate to teams (idempotent)
bun --env-file=<env> run src/scripts/sync-object-tables.ts        # create + RLS-arm every team's data.obj_* tables (idempotent)
```

`reseed-system-ontology.ts` is what gives every existing org/team its **default
objects** (system + starter types); `sync-object-tables.ts` provisions and arms
their physical tables.

#### 4. Verify

```
AI_DB_READONLY_URL=<role-conn> bun --env-file=<env> run src/scripts/check-objects-rls.ts
```

Must print `✅ RLS check passed` (structural arming on every `data.obj_*` +
functional isolation / grant / share as the role). Non-zero exit = stop.

#### 5. Make the AI schema-aware (required, or the SQL tool breaks)

The live `production` Langfuse prompt still describes the old `v_*` views, which no
longer exist. Publish the current prompt (which targets `data.obj_<typeId>`):

```
cd backend/packages/ai && bun run langfuse:seed-prompts
```

Without this, the agent's SQL tool references dropped views and fails. NOTE: this
ships only the **schema-accurate** prompt — the full objects-awareness + proactive
autonomy rewrite is **P8**. Prefer deploying prod _after_ P8 so the agent is
coherent about objects; if you deploy before P8, this step is still mandatory.

#### 6. Restart note

A fresh deploy already loads the new `objects.py` SDK tarball (bundled at module
load). Only relevant if you hot-restart without redeploying.

### Verifying — `check-objects-rls.ts`

Repeatable, two phases (see the file header):

1. **Structural** (owner conn): asserts every `data.obj_*` has `rowsecurity = on`,
   the `sql_tool_read` policy, and `SELECT` granted to `fretik_sql_tool`; that
   `object_records`/`object_types` keep their sharing-aware policies + grant; and
   that the `fretik_*` helper functions exist.
2. **Functional** (as the `fretik_sql_tool` role, needs `AI_DB_READONLY_URL`):
   builds a throwaway fixture and proves team isolation, type-grant honoring
   (team-scoped + org-wide), and record-share honoring — then tears it down.

```
AI_DB_READONLY_URL=postgres://fretik_sql_tool:…@host/db \
  bun --env-file=../../.env run src/scripts/check-objects-rls.ts
```

Exit code is non-zero if any assertion fails.

> Known gap (tracked for the AI-coherence pass, P8): the `object_types` SELECT
> policy is team-OR-org-template, **not** grant-aware. A foreign type granted to a
> team is visible in its `data.obj_*` rows (the data policy honors
> `fretik_type_granted`) but the type's catalog row is not SELECTable by that
> team's SQL role. Service-layer reads (owner connection) already surface granted
> foreign types; only the SQL-tool path is affected.
