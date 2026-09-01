# Deploying `feat/model-foundation`

Operator checklist for shipping the model-foundation branch (both repos) to production.
Single Docker image via Dokploy; DB migrations run automatically at container boot
behind a Postgres advisory lock (`packages/shared/src/db/index.ts` → `runMigrationsWithLock`).

## What this branch ships (vs `main`)

- **Backend** (`backend/`, branch `feat/model-foundation`): model registry + tiers (C1–C2),
  promotion gate (C3), turn robustness (C4), prompt/tool hardening (C6), SQL-tool hardening
  (C10), eval-efficiency metrics (C11), extended-thinking + reasoning gating (C7), plus this
  session's web-egress hardening, correctness-advisory gate, C8b per-team model resolution,
  and reasoning-strip.
- **Backend migrations introduced — exactly two:**
  - `20260612123154_harden_sql_tool` (C10)
  - `20260614125811_happy_doctor_octopus` (C8 — `team_ai_settings` table + `ai_conversations.model_profile_key`)
  - All older migrations (auth_overhaul, backfill_email_verified, collab, …) are already on `main` = already deployed.
- **Frontend** (`app/`, branch `feat/model-foundation`): 2 commits over `main` — C4 transparent-failover
  stream errors and the C7 extended-thinking toggle + model picker. No DB changes; it consumes the
  backend `team_ai_settings` / `model_profile_key`.

---

## A. Database out-of-band step (run once, on the prod DB)

The `harden_sql_tool` migration creates the least-privilege role `fretik_sql_tool` with
`LOGIN` **but no password** (fail-safe — it cannot authenticate until you set one). The migration
itself runs as the app owner at boot; it grants `SELECT` on 9 product tables only, enables
row-level security keyed on the per-transaction session var `fretik.team_id`, and exposes identity
solely through the curated `chatbot_org_members` view. RLS is `ENABLE`-only (never `FORCE`), so the
app owner (API/worker) keeps bypassing it — existing queries are unaffected.

Operator action, once, before the AI service serves traffic:

```sql
ALTER ROLE fretik_sql_tool LOGIN PASSWORD '<strong-random-password>';   -- e.g. openssl rand -hex 32
```

Then wire `AI_DB_READONLY_URL` (section B) to that role. Idempotent: safe to re-run; the role is
only created if absent.

---

## B. Environment variables (set on the Dokploy AI service)

### New this branch — **REQUIRED**

| Var                  | Value                                            | Notes                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_DB_READONLY_URL` | `postgres://fretik_sql_tool:<pw>@host:5432/<db>` | **Hard boot failure if unset** (`packages/ai/src/lib/db-readonly.ts` throws). Point at the `fretik_sql_tool` role from step A — **never** at `DATABASE_URL` (the owner bypasses RLS). |

### New this branch — optional (safe defaults)

| Var                        | Default | Effect                                                                      |
| -------------------------- | ------- | --------------------------------------------------------------------------- |
| `AI_DB_READONLY_POOL_MAX`  | `10`    | Max read-only connections per pod.                                          |
| `AI_WEB_BLOCKED_DOMAINS`   | empty   | Never-fetchable domains (also dropped from `searchWeb` results).            |
| `AI_WEB_ALLOWED_DOMAINS`   | empty   | When non-empty, flips `webFetch` to deny-by-default (only these fetchable). |
| `AI_WEB_FETCH_MAX_URL_LEN` | `2048`  | Max fetch-URL length (chars).                                               |
| `AI_WEB_TOOLS_ENABLED`     | enabled | Set `"false"` to fully disable `webFetch` + `searchWeb`.                    |

> Web egress is **open by default**; always-on hygiene (scheme, private-IP/metadata, length,
> punycode) applies regardless. The four `AI_WEB_*` vars are opt-in tightening levers.

### Jobs service — **REQUIRED** (the nightly model sync runs there, not on the AI service)

The model sync cron (`model-sync-nightly`, 00:30 UTC) executes in the **jobs** container, so the
jobs service needs its own copies of three keys the AI service already has. Without them the sync
still reports `ok` while writing degraded data — this exact failure shipped once (2026-09-01:
OpenRouter returns `throughput_last_30m: null` on unauthenticated calls, HTTP 200, so every
openrouter endpoint lost its percentiles and the throughput/TTFT policy rules silently never ran):

| Var                           | Why the jobs service needs it                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`          | OpenRouter `/endpoints` percentiles (`throughput_last_30m`, `latency_last_30m`) are auth-gated.   |
| `ARTIFICIAL_ANALYSIS_API_KEY` | AA intelligence/coding/agentic indices; unset = empty map = `intelligence-floor` never evaluates. |
| `AI_GATEWAY_API_KEY`          | ZDR probe + quarantine re-probe; unset = expired quarantines are never re-checked.                |

Mirror any future secret read under `packages/shared/src/services/model-registry/sync/` onto the
jobs service — that code runs wherever the sync runs.

### Pre-existing — must already be set (not new, but required to boot)

`OPENROUTER_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `E2B_API_KEY` (+ template), `MISTRAL_API_KEY`,
`TAVILY_API_KEY`, `LANGFUSE_*` (optional — tracing is a no-op without them), Better-Auth + S3/Scaleway
vars. `ARTIFICIAL_ANALYSIS_API_KEY` is **optional** (live model-intelligence metrics; the service
logs "using fallback" and serves static metrics when unset). The full annotated set is in
`packages/ai/.env.example`.

---

## C. Build / seed commands

- **Langfuse managed prompts** — `system-prompt.md` changed vs `main` this branch (C6/C7). If prod
  serves prompts from Langfuse prompt-management, re-seed so prod picks up the change:
  ```bash
  cd backend/packages/ai && bun run langfuse:seed-prompts
  ```
  (No-op-safe to re-run. Skip only if prod reads prompts from the bundled `.md` at runtime — operator confirms which.)
- **E2B template** — no template change on this branch; **skip** `e2b:build` unless
  `packages/shared/src/services/e2b/template/` was touched.

---

## D. Migrations

Both new migrations auto-apply at boot under the advisory lock — nothing to run by hand in prod.

- `harden_sql_tool`: role + grants + RLS + `chatbot_org_members` view. Owner unaffected; only
  `fretik_sql_tool` is constrained. Requires step A to be usable.
- `happy_doctor_octopus`: adds `team_ai_settings` (PK `team_id` → `team` ON DELETE CASCADE; nullable
  `flagship/workhorse/utility_profile_key`) and a nullable `ai_conversations.model_profile_key`.
  Backward compatible: existing rows keep `NULL`; with no per-team override the registry default is used.

Dev/prod migration history is consistent (generate → migrate workflow; no `db:push`).

---

## E. Verification gate

**Offline (CI / pre-merge), all green:**

```bash
cd backend/packages/ai     && bun run check && bun run test
cd backend/packages/shared && bun run check && bun run test
cd backend/packages/api    && bun run check
cd app                     && bun run typecheck && bun run lint && bun run build
```

**Live flagship re-validation (operator, needs running service — guards the reasoning-strip on the
M3 hot path):**

```bash
cd backend/packages/ai
AI_SERVICE_URL=<live-url> bun run evals:gate        # M3 flagship, baseline-compare
# or full: AI_SERVICE_URL=<live-url> bun run evals:langfuse
```

Accept only with **0 regression vs the C5 baseline**: `tool-use` = 1.000 (17/17) and
`multimodal` = 1.000 (4/4). If either regresses, do not ship the reasoning-strip — investigate first.

**Post-deploy smoke:**

1. Container logs show the migration lock acquired → released on boot.
2. AI service boots (no `Missing AI_DB_READONLY_URL` throw).
3. One chatbot SQL-tool turn returns team-scoped rows (RLS working).
4. `webFetch` / `searchWeb` behave per the `AI_WEB_*` policy you set.

---

## F. Rollout order

1. On prod DB: `ALTER ROLE fretik_sql_tool LOGIN PASSWORD …` (step A).
2. Set env vars (section B) — at minimum `AI_DB_READONLY_URL`.
3. Run `langfuse:seed-prompts` if prompts are Langfuse-managed (section C).
4. Deploy the image → migrations auto-run at boot.
5. Post-deploy smoke (section E).
