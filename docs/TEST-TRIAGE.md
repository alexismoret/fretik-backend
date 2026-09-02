# Test triage

Every test file that faked the database, judged one by one, with the evidence.
Started 2026-09-02, **finished the same day** — this is now the record of what
was done and why, plus the three files that deliberately still fake `db`.

## The rule

> **If the assertion still holds when you delete the `where` clause, the test is
> not testing the query.**

That single question sorted every file below, and it is sharper than the rule it
replaced ("never mock `src/db`"), which would have been wrong for three of the
twelve files here. A fake `db` is legitimate in exactly two shapes:

- **poison** — the fake exists to prove NO query happens (it throws on use);
- **silencer** — the subject's data comes from other, deliberately doubled
  services, and `db` is only in the import graph.

It is illegitimate in one shape, and this is the one that kept appearing:

- **stand-in** — the fake re-implements the `where` in JavaScript, so the test
  asserts that the FAKE filtered. Delete the predicate from the service and the
  test stays green. Almost every instance found also ignored the one predicate
  whose failure is a cross-tenant leak.

## Done

| File                                  | Was                                                                                                                                                                                                        | Now                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page-connection-validate`            | stand-in: re-implemented the `status` filter, ignored `teamId`                                                                                                                                             | `shared/tests/integration/pages/validate-connections.test.ts`, 11 tests, + a cross-team leak test the fake could not express                                                          |
| `page-connection-resolve`             | stand-in: `findMany` returned the fixture list whatever the `where` said; three tests asserted on the recorded `where` OBJECT                                                                              | `shared/tests/integration/external-apps/resolve-for-page.test.ts`, 21 tests. The privacy rule (a shared page must not spend a colleague's credentials) is now an outcome, not a shape |
| `workflow-runaway-guard`              | stand-in: `where: async () => queuedRuns` honoured none of the four predicates                                                                                                                             | `shared/tests/integration/workflows/runaway-guard.test.ts`, 13 tests, one per exclusion the four-predicate WHERE exists to make                                                       |
| `api/tests/unit/health.test.ts`       | re-implemented the route inside the test, then asserted it returned what the test had told it to                                                                                                           | deleted; replaced by `auth-boundary.test.ts`                                                                                                                                          |
| `page-record-writes` (17)             | stand-in: a hand-written `matches(row, where)`; `linkTypes.findFirst` answered `{id:"link-type-1"}` to every query; `links.findMany` returned the whole fixture list, so the bi-temporal clauses never ran | `unit/page-operation-schema.test.ts` (5, pure Zod) + `integration/pages/record-writes.test.ts` (22)                                                                                   |
| `model-registry-breaker` (19)         | stand-in: `update().set().where()` DROPPED the where; `readLiveStateRowForUpdate` mocked, so the `SELECT … FOR UPDATE` never ran                                                                           | `unit/model-registry-breaker-pool.test.ts` (5, pure) + `integration/model-registry/breaker.test.ts` (15)                                                                              |
| `model-registry-admin` (22)           | stand-in: asserted `set()` payloads and `onConflictDoNothing` TARGETS against a fake that recorded them                                                                                                    | `integration/model-registry/admin.test.ts` (29). No split: the verdict logic already had `model-registry-promotion-budget.test.ts`                                                    |
| `page-publish-dry-run` (32)           | stand-in: `pages.findFirst` matched `id` OR `publicToken` and knew nothing else, so `teamId` and the visibility clause were in no test                                                                     | `unit/page-dry-run.test.ts` (6, inline datasets only) + `integration/pages/publish.test.ts` (23) + `integration/pages/dry-run.test.ts` (8)                                            |
| `page-run-gates` (9)                  | stand-in: `findFirst: () => connection` regardless of scope; the viewer-preference table always answered `[]`                                                                                              | `integration/pages/run-operation.test.ts` (12)                                                                                                                                        |
| `ai tools/read` (21)                  | stand-in: a `db` Proxy keyed `${conversationId}::${filename}`                                                                                                                                              | `ai/tests/integration/tools/read.test.ts` (22)                                                                                                                                        |
| `ai tools/vision-extracted-image` (9) | stand-in on `aiChatFiles` (conversation) AND `fileExtractions` (organization)                                                                                                                              | `unit/tools/vision-pages.test.ts` (5, sandbox only) + `integration/tools/vision-extracted-image.test.ts` (7)                                                                          |
| `ai tools/transform` (11)             | **silencer, and removable** — see below                                                                                                                                                                    | stays unit, with no `db` double at all                                                                                                                                                |

Two claims the triage had asked for separately are now in place:
`integration/pages/dry-run.test.ts` covers the unknown / other-team collection
verdicts, and `integration/model-registry/action-log.test.ts` (3) covers the
`model_admin_actions` insert.

### Where the triage's own analysis was wrong

- **`transform` was not a stand-in.** Its fake answered `undefined` to every
  table and predicate. What it silenced was not the tool but the SANDBOX
  FIXTURE: `conversation-storage` looks `ai_conversations` up while pushing the
  skills tarball and swallows the failure, so every sandbox test printed
  `failed query: select "team_id" from "ai_conversations"` and passed. The
  fixture already stubbed the two sibling list services for exactly that reason
  and had missed the third; it now stubs `list-snapshots-for-conversation` too,
  and the double in the test is gone.
- **`model-registry-admin` did not need splitting.** Its "verdict logic is pure"
  half is `promotion-budget`, which already had its own file.

### One test deleted rather than converted

`model-registry-breaker`'s "a failed write announces nothing" wrote
`expect(quarantine(…)).rejects.toThrow(…)` **without awaiting**, then asserted
on `alerts` and `invalidations` on the next line — synchronously, before the
promise settled. Both were empty at that moment whatever the code did, so the
test could not fail. Its subject (the lock that makes the announce step safe) is
now covered from the other side, and much harder: four concurrent
`quarantineProvider` calls on one row must ALL survive. That mutation-detects
5 runs out of 5 with the lock removed; two concurrent writers only caught it 2
out of 3, which is why the count is four.

## Still faking `db`, on purpose — with the reason

| File                                                  | Why it stays                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/tests/unit/file-extraction-guards.test.ts`    | The `db` fake is **poison**: `insert`/`update` throw with "must not be reached by guarded paths". The test's whole claim is that no write happens. A real database would weaken it to "no row appeared", a much smaller statement.                                                                                                                                     |
| `shared/tests/unit/page-data-boundary.test.ts`        | **Silencer.** The data comes from `listCollectionRecords` / `aggregateRecords` / `getFieldDefinitionsForTeam`, all doubled deliberately; `db` only answers a one-line `collections.findFirst` existence probe. The subject is limits, descriptors and refusals — none of it SQL. The refusal claims it could not make now live in `integration/pages/dry-run.test.ts`. |
| `shared/tests/unit/model-registry-operations.test.ts` | **Silencer.** Every verdict comes from `admin` / `breaker` / `add-from-catalogue`, all doubled; `db` only captures the action-log insert. That the insert LANDS is now `integration/model-registry/action-log.test.ts`.                                                                                                                                                |

## Found while converting

Four of these are recorded, not fixed; two were fixed.

- **FIXED — `resolvePageAccess` raised a 500 on a malformed token.** `public_token`
  is a `uuid` column, so a token that is not one made Postgres raise `invalid
input syntax for type uuid`, which would reach an anonymous caller as a 500
  carrying a database message. Not live: the public API route guards both call
  sites, and keeps doing so (there it also saves a round trip on the one
  endpoint whose request rate an abuser controls). The guard is now in the
  SERVICE too — same doctrine as the registry guards moved out of the CLI on
  2026-08-31: a guard in one caller protects that caller, not the export.
- **FIXED — integration runs traced to the production Langfuse.** The env wall
  emptied `LANGFUSE_*` for unit tests only, and integration's `??=` handed over
  `.env`'s keys, so a laptop's `test:integration` posted observations to the real
  project under the developer's own credentials. CI never noticed: it has no
  Langfuse secrets, so the only environment where this was visible was the one
  nobody watches. Now emptied for both families.
- **FIXED — only `@fretik/jobs` checked that the Redis was disposable.** Found
  the hard way: `docker run -p 6379:6379` appeared to work, but a native
  `redis-server` already held `127.0.0.1:6379` on the loopback address while
  Docker bound the wildcard, so `redis://127.0.0.1:6379` reached the DEV
  instance — full of real cache keys and BullMQ queues — and shared/ai
  integration runs wrote to it for an afternoon. `jobs` refused on the first
  try. The marker check (`fretik:disposable`) is now in all three preloads,
  verified in both directions. In `ai` it opens its own ioredis connection: that
  package's preload replaces `@fretik/shared/lib/redis` with `redis-double`
  before any file runs, and a double answers `null` to everything — it would
  have refused every instance including the right one.
- **KNOWN GAP, pinned — a page dataset over another team's collection reports
  `ok`, not `forbidden`.** `collectionsSource` probes `where: { id }` with no
  scope, so `forbidden` fires only for an id that exists nowhere. **No rows
  cross** — verified in `integration/pages/dry-run.test.ts` against a real
  neighbouring record — so this is a misleading message, not a leak: the author
  is told "no rows, check your filters" when the truth is "not your collection".
  Not fixed here because the right predicate is not `teamId` equality (reads
  legitimately honour cross-team grants via `collection-sharing/access`) and
  `PageDataSource` is handed no `organizationId` to check one against. The test
  asserts today's behaviour and will fail the day that is threaded through.
- **`conversation-storage` swallows a database failure during sandbox bootstrap.**
  `pushMcpConnectionOverlay` soft-fails by design, which is right — but it means
  a genuinely broken MCP overlay is indistinguishable from an offline test.
- **Two `ai` test files were in the wrong family.** `tools/python.test.ts` and
  `tools/vision.test.ts` sat under `tests/integration/` while their own headers
  said "Unit tests for the … tool", and neither touched a database. Moved.
- **Industry vocabulary in core test fixtures.** `hybrid-search.test.ts` queries
  `"freight rates and carrier shipping information"` and `list-index.test.ts`
  seeds `carriers/dhl.md` / `"BL = Bill of Lading"`. The root `CLAUDE.md` puts
  that vocabulary in a template, never in the core. Changing fixture strings
  changes what the assertions measure, so this is a deliberate edit, not a
  rename.
- **The public routers' rate limiters block on Redis.** Found by hanging the api
  auth probe against a dead port: `/p/:token` and `/forms/:token/submit` run a
  Redis-backed limiter that waits rather than failing open or closed. Worth
  deciding which of the two it should do when Redis is unreachable.

## Counts

|                    | before   | after    |
| ------------------ | -------- | -------- |
| shared unit        | 1227     | 1144     |
| shared integration | 54       | 166      |
| ai unit            | 928      | 919      |
| ai integration     | 188      | 202      |
| **total**          | **2397** | **2431** |

Nothing was dropped except the one test above that could not fail.
