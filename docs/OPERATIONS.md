# Operations

How this backend is deployed, migrated, and poked at by hand. One document; if
something operational is not here, it is not written down.

---

## 1. The rule

> **A laptop never migrates. Only a Dokploy service with `RUN_MIGRATIONS=true`
> migrates. Operator scripts run inside the container.**

It comes from an incident. On 2026-08-30, `packages/shared/src/db/index.ts` ran
`runMigrationsWithLock()` **at module import**, guarded only by
`NODE_ENV !== "test"`, resolving the migration folder from the local checkout.
A routine `bun run models:admin …` from a laptop, with `DATABASE_URL` pointed at
the production tunnel, therefore applied `20260830125622_wealthy_lucky_pierre`
to production — two days before the code that needed it shipped. That migration
tightens `account.issuer` to `NOT NULL`; the running code (Better Auth 1.6.23)
inserted accounts without it. **Every sign-up returned a 500 for two days.**

Three things had to be true at once, and all three are now false:

| Then                                                      | Now                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Importing the database handle applied migrations          | `@fretik/shared/db` is a handle. Applying lives in `@fretik/shared/db/migrations` and **refuses without an authority** |
| Any process with a `DATABASE_URL` could be that authority | An authority is `RUN_MIGRATIONS=true` on a service boot, or an operator past the guard in `lib/operator-guard.ts`      |
| Nothing said which database it was talking to             | Every guarded script prints `[target] … db=… host=… user=…` before it does anything                                    |

**Never infer "production" from `NODE_ENV`, a hostname or a port.** An SSH
tunnel makes production look exactly like `127.0.0.1:5434`, and Bun auto-loads
`.env.production.local` the moment `NODE_ENV=production`. What cannot be
disguised is the database's own name (`current_database()`) and whether the
process is inside the deployed image (`FRETIK_RUNTIME=container`, set in all
three Dockerfiles). Those are the two facts the guard reads.

---

## 2. A deployment, step by step

```
push to main
  └─ .github/workflows/backend.yml
       ├─ check          typecheck + lint + format + `db:check` (offline journal ↔ schema)
       ├─ unit           every package's `test` — hermetic, no services
       ├─ integration    ephemeral Postgres + Redis:
       │                   1. apply all migrations to an EMPTY database
       │                   2. `db:status` → nothing pending
       │                   3. re-apply → idempotent
       │                   4. shared + ai + jobs `test:integration`
       └─ build-and-push → GHCR (only the services whose code changed) → deploy → Dokploy
                              ↓
                        container boot
                          ├─ RUN_MIGRATIONS=true → migrate under advisory lock 4242424242424242
                          └─ otherwise           → assertMigrationsCurrent(), CRASH if anything is pending
                              ↓
                            serve
```

Two properties of that picture matter more than the rest:

**Step 1 of the integration job is the check that would have caught the
incident.** A migration must apply to an empty database _and_ the current code
must pass on top of the result. Neither half alone would have.

**A service that does not migrate refuses to serve an older schema.** With
`RUN_MIGRATIONS` unset and migrations pending, boot throws and Docker restarts
the container in a loop. That is deliberate: continuing would mean new code on
an old schema, which is the incident wearing different clothes. The loop is
loud, and the previous container keeps serving behind the healthcheck.

All three services carry `RUN_MIGRATIONS=true`. Whichever boots first wins the
advisory lock and migrates; the others find nothing to do. The order is not
guaranteed and does not need to be.

---

## 3. Where does my new script go?

| Class                | Runs where                                         | Mechanism                                  | Examples                                                                                     |
| -------------------- | -------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **verify / codegen** | CI `check` job + husky                             | package scripts                            | `db:check`, `file-types:sync --check`, `measure:tokens`, `lint-migrations`                   |
| **migrations**       | service boot, `RUN_MIGRATIONS=true`                | `db/migrations.ts`                         | `drizzle/*`                                                                                  |
| **release tasks**    | service boot, after migrations, once per `GIT_SHA` | ledger (§8)                                | `langfuse-seed-prompts`, `models-audit`                                                      |
| **periodic**         | the jobs container                                 | BullMQ schedulers (`queues/schedulers.ts`) | model sync 00:30, bench 01:15, dreaming 03:00, GC 04:00                                      |
| **ad-hoc operator**  | **inside** the container, via `docker exec`        | operator guard                             | `models:admin`, `models:bench`, backfills, `memory:audit`, `grant:super-admin`, `db:migrate` |
| **evals**            | a laptop, against a reachable non-prod service     | `evals/*`                                  | `evals:gate` — see `packages/ai/evals/RUNBOOK.md`                                            |

Rules of thumb:

- **Anything that opens the database gets `assertOperatorTarget(Bun.argv)` as
  its first awaited statement.** Read-only included: the point is the `[target]`
  line as much as the refusal. The one exception is `db:status`, which exists to
  be pointed at anything, including production through a tunnel.
- **Do not duplicate BullMQ schedules as Dokploy Schedules.** Two schedulers,
  one of them without a ledger, means duplicate nightly runs.
- **Do not run operator scripts from CI.** CI cannot reach production by design,
  and it would execute the checkout rather than the deployed image.

### Running one in production

```bash
ssh root@<host> "docker exec -w /app/packages/ai \
  \$(docker ps -q -f name=fretik-ai -f status=running) \
  bun run models:admin -- list --target=prod"
```

`-w` picks the package whose `package.json` holds the script. Both conditions
are then satisfied: `--target=prod` is the deliberate part, and
`FRETIK_RUNTIME=container` is the part a laptop cannot fake.

Break-glass, logged loudly and to be used only when the container genuinely
cannot run it: `FRETIK_ALLOW_LAPTOP_PROD=1` alongside `--target=prod`.

---

## 4. Writing a migration that can be deployed

A deploy is never atomic. For minutes, the **old containers** and the **new
schema** coexist. So a migration must be compatible with the code that is
already running — not with the code it ships beside.

`scripts/lint-migrations.ts` flags the four shapes that are not (advisory, runs
on PRs). The one worth internalising:

**`20260830125622` is a textbook expand/contract migration and it still caused
the incident.** Look at it: add the column nullable, backfill it in two
`UPDATE`s, _then_ `SET NOT NULL`, then the unique index. Every step is right.
What was wrong was the _release_ it shipped in — the tightening landed while the
code that inserts without `issuer` was still serving traffic.

The safe sequence is two releases:

1. **Expand.** Add the column nullable (or with a `DEFAULT`), backfill it. Ship
   the code that starts writing it. Both old and new code work.
2. **Contract.** In the _next_ release, `SET NOT NULL`, add the constraint, drop
   what nothing reads any more.

Same for the reverse: stop reading a column in one release, drop it in the next.

---

## 5. Environment

### All three services

`DATABASE_URL`, `REDIS_URL`, `RUN_MIGRATIONS=true`, plus Better Auth and
Scaleway S3/email variables. `FRETIK_RUNTIME=container` comes from the image.

### `@fretik/ai`

| Var                                                                      | Notes                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_DB_READONLY_URL`                                                     | **Hard boot failure if unset.** The least-privilege `fretik_sql_tool` role — never `DATABASE_URL`, whose owner bypasses RLS. See the one-off step below.                                                                   |
| `AI_DB_READONLY_POOL_MAX`                                                | Default `10`.                                                                                                                                                                                                              |
| `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `TAVILY_API_KEY`, `E2B_API_KEY` | Model routing, OCR, web search, sandboxes.                                                                                                                                                                                 |
| `AI_WEB_*`                                                               | Opt-in egress tightening (`AI_WEB_BLOCKED_DOMAINS`, `AI_WEB_ALLOWED_DOMAINS`, `AI_WEB_FETCH_MAX_URL_LEN`, `AI_WEB_TOOLS_ENABLED`). Always-on hygiene — scheme, private-IP/metadata, length, punycode — applies regardless. |
| `LANGFUSE_*`                                                             | Optional; tracing is a no-op without them.                                                                                                                                                                                 |

### `@fretik/jobs` — three keys people forget

The nightly model sync runs in the **jobs** container, not the AI one, so jobs
needs its own copies:

| Var                           | What breaks without it                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`          | `/endpoints` percentiles are auth-gated. Unauthenticated calls return `throughput_last_30m: null` with **HTTP 200** — this shipped once (2026-09-01): every OpenRouter endpoint silently lost its percentiles, the throughput/TTFT policy rules never ran, and the sync still reported `ok`. |
| `ARTIFICIAL_ANALYSIS_API_KEY` | Empty intelligence map ⇒ the `intelligence-floor` rule never evaluates.                                                                                                                                                                                                                      |
| `AI_GATEWAY_API_KEY`          | ZDR probe + quarantine re-probe ⇒ expired quarantines are never re-checked.                                                                                                                                                                                                                  |

**Mirror any future secret read under
`packages/shared/src/services/model-registry/sync/` onto the jobs service** —
that code runs wherever the sync runs.

### One-off, on the production database

`harden_sql_tool` creates the role `fretik_sql_tool` with `LOGIN` and **no
password**, so it cannot authenticate until an operator sets one. It holds
`SELECT` on the product tables only, under row-level security keyed on the
per-transaction `fretik.team_id`, with identity exposed solely through the
`chatbot_org_members` view. RLS is `ENABLE`-only (never `FORCE`), so the app
owner keeps bypassing it and existing queries are unaffected.

```sql
ALTER ROLE fretik_sql_tool LOGIN PASSWORD '<openssl rand -hex 32>';
```

Then point `AI_DB_READONLY_URL` at that role. Idempotent; safe to re-run.

`bun run --filter '@fretik/shared' check:collections-rls` verifies the whole
arrangement end to end and prints which database it verified.

---

## 6. Reading the state

```bash
bun run --filter '@fretik/shared' db:status   # target, applied count, pending names; exit 1 if pending
```

Read-only, and it prints the target the **server** reports — `current_database()`
and `inet_server_addr()` — not the URL you believe in. It is the one command
that may be pointed anywhere.

---

## 7. Test conventions

Two families, one boundary.

|          | Unit                                                      | Integration                                               |
| -------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Subject  | pure logic, policy, narration, guards                     | correctness that lives **in the SQL**                     |
| Command  | `bun run test`                                            | `bun run test:integration`                                |
| Services | none — the preload points every URL at port `1`           | a real Postgres, and a real Redis for `jobs`              |
| Doubles  | at process boundaries only (`mockModule`, `redis-double`) | the same, for third parties (Trigger.dev, the AI service) |

**The rule that decides which:** _if the assertion still holds when you delete
the `where` clause, the test is not testing the query._ A double that
re-implements a filter in JavaScript proves only that the double filtered — three
suites here asserted exactly that until 2026-09-02, and the `teamId` predicate
whose failure is a cross-tenant leak was never exercised by any of them.

Running the integration suites:

```bash
export DATABASE_URL=postgres://…/fretik_test
export REDIS_URL=redis://…
bun run --filter '@fretik/shared' test:integration
```

Two locks stand in front of them, both designed against the tunnel:

- **Postgres** — the database's own NAME must carry `test` or `ci` as a whole
  word at one end (`fretik_test`, `test-fretik`; not `fretik`, not
  `fretik_dev_restore`).
- **Redis** — the instance must hold the key `fretik:disposable`. An instance
  cannot report its own name, so this is a marker an operator sets deliberately;
  production does not have it and a tunnel cannot forge it. `jobs`
  `obliterate()`s whole queues, and shared/ai write cache entries, so all three
  packages check it (they did not until 2026-09-02 — see below).

  ```bash
  redis-cli SET fretik:disposable "<why this instance is disposable>"
  ```

**Reproducing the CI integration job locally**, which is worth doing before
touching `backend.yml`:

```bash
docker build -t fretik-ci-postgres .github/postgres     # postgis AND pgvector
docker run -d --name ci-postgres -e POSTGRES_USER=fretik \
  -e POSTGRES_PASSWORD=fretik -e POSTGRES_DB=fretik_test -p 5432:5432 fretik-ci-postgres
docker run -d --name ci-redis -p 6380:6379 redis:8-alpine
docker exec ci-redis redis-cli SET fretik:disposable "local CI reproduction"
```

**Port 6380, not 6379, and this is the whole reason the Redis marker exists.**
A dev machine usually runs a native `redis-server` bound to `127.0.0.1:6379`
specifically, while Docker's `-p 6379:6379` binds the wildcard — the container
starts, `docker port` reports the mapping, and `redis://127.0.0.1:6379` still
reaches the DEV instance. On 2026-09-02 an afternoon of "CI reproduction" wrote
into a developer's own Redis that way. `jobs` refused on the first try because
it already checked the marker; shared and ai had no such check and said nothing.
They do now. Use a port nothing else can own, and let the marker be the thing
you trust — not the port number.

`randomize = true` is in every `bunfig.toml`: a suite that only passes in one
order is a bug, and it should surface on the machine that wrote it.

---

## 8. Release tasks — what a deploy does by itself

Some jobs have to happen on every deployment, and the only mechanism used to be
a person remembering. A forgotten `langfuse:seed-prompts` leaves production
running the previous prompt while git says otherwise, and nothing reports the
gap — it surfaces as the assistant behaving like last week.

A **release task** runs once per deployed version, automatically, on a service
that boots with the credentials it needs.

- **The ledger** is `release_tasks`, unique on `(name, version)`. A claim is one
  statement — `insert … on conflict … do update … where` — so three services
  booting from the same image, with replicas, produce exactly one winner.
- **The version is `GIT_SHA`**, baked into the image (`ARG GIT_SHA` in all three
  Dockerfiles, `build-args` in `backend.yml`). **Not** `package.json.version`:
  `version-bump` commits _after_ the build, so the number inside an image lags
  by one and two different images can carry the same one.
- **Failure is retried, success is not.** A task that throws is recorded
  `failed` and re-claimed on the next boot of the same version. A `running` row
  older than 30 minutes is treated as abandoned — otherwise one crash would
  mean the task never runs again, including on the redeploy done to fix it.
- **Nothing is fatal to the boot.** `runReleaseTasks` is called un-awaited,
  after the server is listening, and never throws.

### What actually runs, and the bar to add one

| service | task                    | why it is safe to run on every deploy                                                                                                             |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ai      | `langfuse-seed-prompts` | publishes only what CHANGED (each prompt is diffed against the live `production` version); Langfuse keeps the previous version beside the new one |
| ai      | `models-audit`          | a pure READ; a finding raises a `model_alerts` row the existing digest sends, and never marks the task failed                                     |

**Three things disqualify a script, and each has ruled one out:**

1. **Not needed on every deploy.** `reseed-system-ontology` matters when the
   seeded set changes — a handful of times a year. A job that is usually a
   no-op still writes, still takes time, and still has to be right, for nothing.
2. **Could damage data that is already correct.** `sync-collection-tables` does
   DDL across every team including column DROPS. Its own header calls it a
   backfill/repair primitive: teams get their tables at creation time.
3. **Writes fixtures into the target database.** `check-collections-rls`
   creates a real organization, two teams and records to verify isolation, then
   deletes them. Correct for a verification an operator drives; unacceptable as
   something that happens to production because somebody merged.

`langfuse-seed-eval-config` fails the first test: it is a one-time bootstrap,
and Langfuse score configs cannot be deleted.

Stated positively — a release task READS, or writes something whose previous
value nobody depends on, and doing it twice is the same as doing it once.

### Reading what happened

```sql
select name, version, service, outcome, detail, duration_ms
from release_tasks order by started_at desc limit 20;
```

Rows are never deleted: "which deploy published that prompt, and did it work"
is the question this table exists to answer months later.
