// Compiles every Zod schema on first use (zod 4.5). Side-effect import, ahead
// of the tracer so no schema is parsed before the compiler is installed. Valid
// input takes the compiled path, invalid input falls back to the normal
// parser — error reporting, including tool-arg repair, is unchanged.
import "zod/compile";

// OpenTelemetry tracing bootstrap (Langfuse). Side-effect import — MUST be
// first so the global tracer provider is registered before any model call
// creates a telemetry span. No-op when LANGFUSE_* env vars are absent.
import "./lib/langfuse";

// AI SDK warning routing (and the one provider warning it silences — see the
// module). Side-effect import, before any model call.
import "./lib/sdk-warnings";

// Patches Zod with `.openapi()`. Side-effect import, and it MUST precede every
// `@fretik/*` import: the formatter sorts `@fretik` before `@hono`, so any
// shared module reaching `schemas/common/params` (which calls `.openapi()` at
// module load) would otherwise evaluate against an unpatched Zod and throw at
// boot. This file's leading side-effect imports are comment-separated groups,
// which the sorter leaves in place — that is what makes the order enforceable.
// oxlint-disable-next-line import/no-duplicates
import "@hono/zod-openapi";

// Bootstrap external-app provider registration (side-effect import — must
// run before any chatbot tool or sandbox-exec touches the registry).
import "@fretik/providers";

import {
  assertMigrationsCurrent,
  runMigrationsWithLock,
} from "@fretik/shared/db/migrations";
import { errorHandler } from "@fretik/shared/lib/error-handler";
import { globalRateLimiter } from "@fretik/shared/lib/rate-limit";
import { reclaimOrphanSandboxes } from "@fretik/shared/services/e2b/reclaim-orphans";
import { installExternalPageQueryExecutor } from "@fretik/shared/services/external-apps/exec/page-query";
import {
  deployedVersion,
  runReleaseTasks,
} from "@fretik/shared/services/release-tasks/runner";
import { syncBundledSkillsCatalogue } from "@fretik/shared/services/skills/sync-bundled-catalogue";
import { OpenAPIHono } from "@hono/zod-openapi";
import figlet from "figlet";
import { cors } from "hono/cors";

import packagejson from "../package.json";
import { chatFilesRoutes } from "./handlers/chat-files";
import { chatbotInternalRoutes, chatbotRoutes } from "./handlers/chatbot";
import { memoryRoutes } from "./handlers/memory";
import { modelAdminRoutes } from "./handlers/model-admin";
import { modelProfilesRoutes } from "./handlers/model-profiles";
import { preExtractRoutes } from "./handlers/pre-extract";
import { vectorizeRoutes } from "./handlers/vectorize";
import { workflowTriggerRoutes } from "./handlers/workflow";
import { workflowTranscriptRoutes } from "./handlers/workflow-transcript";
import {
  boundProfileKeys,
  publishBoundRoles,
} from "./lib/model-registry/bound-roles";
import { getEffectiveProfile } from "./lib/model-registry/effective";
import { warmModelRegistry } from "./lib/model-registry/resolve";
import { aiReleaseTasks } from "./release-tasks";
import { registerOrphanCleanupCron } from "./services/chat-files/orphan-cron";
import { subscribeConversationTaskResumes } from "./services/conversation-tasks/subscribe-resume";
import {
  loadSkillCatalog,
  vectorizeAllBundledSkills,
} from "./skills/materialize";

const VERSION = packagejson.version;

// Migrations are a deployment step, never an import side effect — see
// `@fretik/shared/db/migrations` for the production incident that rule comes
// from. Exactly one of two things is true of every process: the deployment
// opted in and this container migrates under the advisory lock, or it refuses
// to serve a schema older than its own code. Refusing is a crash loop, which
// is loud; the previous container keeps serving behind the healthcheck.
if (process.env.RUN_MIGRATIONS === "true") {
  await runMigrationsWithLock({ kind: "service-boot" });
} else {
  await assertMigrationsCurrent("ai");
}

// managePage's dry_run executes page datasets, including external ones — the
// seam refuses in any process that skips this install.
installExternalPageQueryExecutor();

const app = new OpenAPIHono();

// Global error handler — formats HTTPExceptions as consistent ApiError.
app.onError(errorHandler);

// CORS — credentials:true so the Better Auth cookie is sent cross-origin.
app.use(
  "*",
  cors({
    origin: (origin) => origin,
    credentials: true,
  }),
);

// Broad per-IP anti-abuse backstop (Redis-backed, shared across instances).
// Exempts `/internal/*` (Trigger.dev callbacks + API→AI service calls) and
// `/health` so automatic traffic is never throttled.
app.use("*", globalRateLimiter());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }, 200));

// User-facing chatbot stream (auth cookie middleware inside)
app.route("/chatbot", chatbotRoutes);

// User-facing chat-file upload / delete / download
app.route("/chatbot-files", chatFilesRoutes);

// User-facing model selection (C8) — picker menu + team defaults (cookie auth).
app.route("/model-profiles", modelProfilesRoutes);

// Operator surface for the model engine — SUPER-ADMIN only (cookie auth, then
// the platform-operator flag). Lives here rather than in @fretik/api because
// the fleet view, the audit and the scorecard all read this package's registry,
// which @fretik/api cannot import.
app.route("/model-admin", modelAdminRoutes);

// User-facing live workflow-run transcript (cookie auth, team-scoped).
app.route("/workflow-runs", workflowTranscriptRoutes);

// Internal agent invocations (X-Internal-Key middleware inside)
app.route("/internal/agents/chatbot", chatbotInternalRoutes);

// Internal vectorisation endpoint for @fretik/shared vector-refresh callers.
app.route("/internal/vectorize", vectorizeRoutes);

// Internal pre-extraction endpoint — OCR + structured classification +
// entity extraction. Consumed by @fretik/shared upload pipeline.
app.route("/internal/pre-extract", preExtractRoutes);

// Internal mention extraction for the @fretik/jobs event→graph resolver.
app.route("/internal/memory", memoryRoutes);

// Trigger.dev-facing workflow engine (turn loop, finalize, cron-fire) —
// authenticated by TRIGGER_CALLBACK_KEY, the only public surface in prod.
app.route("/internal/trigger", workflowTriggerRoutes);

// Load the bundled-skills catalog into memory so the system-prompt
// renderer can advertise the L1 listing (skill name + description).
// The skill bundles themselves are pushed to each conversation's
// sandbox at first init by `lib/conversation-storage.ts` — no /tmp
// materialisation here.
const skillCatalog = await loadSkillCatalog();

// Reconcile the on-disk bundled catalogue with the `skills` DB
// table. Adding a new bundled skill folder is all it takes to make
// it appear in DB — no per-skill migration required. The sync only
// touches `name` + `description` (the only frontmatter-derivable
// fields); `is_default` and `version` stay manually-managed.
// Wrapped under a Postgres advisory lock so concurrent replica boots
// don't fight. Soft-fail: a transient error here doesn't block boot
// — the catalogue stays consistent on the next healthy startup.
try {
  const result = await syncBundledSkillsCatalogue(skillCatalog);
  if (
    result.inserted > 0 ||
    result.updated > 0 ||
    result.softDeleted > 0 ||
    result.restored > 0
  ) {
    console.log(
      `[skills-sync] bundled catalogue reconciled: +${result.inserted.toString()} inserted, ${result.updated.toString()} updated, ${result.restored.toString()} restored, ${result.softDeleted.toString()} soft-deleted`,
    );
  }
} catch (err) {
  console.error(
    "[skills-sync] bundled catalogue reconciliation failed:",
    err instanceof Error ? err.message : err,
  );
}

// Boot-time RAG indexer for the bundled skills. Vectorises SKILL.md +
// references/*.md as global rows in `ai_vectors` (team_id IS NULL).
// Idempotent via `metadata.content_hash` short-circuit, fire-and-
// forget so a transient OpenRouter / DB hiccup never blocks boot.
void vectorizeAllBundledSkills().catch((err) => {
  console.error(
    "[boot] skills vectorize failed:",
    err instanceof Error ? err.message : err,
  );
});

// Register the daily chat-files orphan reaper. Idempotent — BullMQ
// deduplicates the repeatable-job key, so calling it from every
// replica is safe and exactly one wins the nightly run.
await registerOrphanCleanupCron();

// Listen for conversations whose background work (workflow runs) has
// finished, so they get resumed here — the only process able to drive a
// chatbot turn. Rides the shared multiplexed subscriber; a signal missed
// during boot is picked up by the 5-min maintenance sweep.
subscribeConversationTaskResumes();

// The workflow / page discovery backfills used to run here, fire-and-forget,
// on every boot. They are migrations for rows that predate the feature — the
// live write path (`handlers/vectorize.ts`) indexes everything since — and a
// row that can never be embedded was retried, and paid for, at every deploy.
// Moved to `bun run backfill:discovery-vectors`, which says why.

// One-shot reclaim of E2B sandboxes orphaned by previous runs (typical
// case: dev hot-reload, server crash, deployment rollover). Steady-
// state reclaim runs on the release path via a Redis SETNX throttle —
// see `releaseSandbox`.
void reclaimOrphanSandboxes().catch((err) => {
  console.warn(
    "[boot] sandbox reclaim failed:",
    err instanceof Error ? err.message : err,
  );
});

// Publish which models the internal roles depend on, then warm the registry so
// the first turn resolves against the database. AWAITED, unlike the backfills
// above: a quarantine written last night has to apply to the first request of
// the day, not to the first request after something else invalidates the cache.
//
// The registry is now database-only — there is no TypeScript fallback behind it,
// because the fallback WAS a second registry with its own staler answers. So a
// database with no rows serves no models, and the check below says which ones
// are missing rather than letting the first request discover it.
await publishBoundRoles()
  .then(({ bound, cleared }) => {
    if (bound > 0 || cleared > 0)
      console.log(
        `[boot] role bindings published — ${bound.toString()} bound, ${cleared.toString()} cleared`,
      );
  })
  .catch((err: unknown) => {
    console.warn(
      "[boot] publishing role bindings failed:",
      err instanceof Error ? err.message : err,
    );
  });
await warmModelRegistry();

const undescribed = boundProfileKeys().filter(
  (key) => getEffectiveProfile(key) === undefined,
);
if (undescribed.length > 0) {
  console.error(
    `[boot] ${undescribed.length.toString()} model(s) an internal role depends on have no live row: ${undescribed.join(", ")}. ` +
      `Turns using those roles will fail. Run \`bun run models:sync\` in the jobs package.`,
  );
}

// Init banner
const text = await figlet.text("fretik AI");
console.log(`
---------------------------
${text}
v${VERSION}
---------------------------
`);

/**
 * One-shot jobs for this deployed version — fire-and-forget, on purpose.
 *
 * AFTER migrations (a task may read a column this deploy added) and LAST in
 * the file, so nothing here can delay the export below: publishing prompts is
 * not part of being ready to serve, and a service that waited for it would
 * hold its healthcheck open on a third party's latency. `runReleaseTasks`
 * never throws — see its own docblock for why that is load-bearing here.
 */
void runReleaseTasks(aiReleaseTasks(), {
  service: "ai",
  version: deployedVersion(VERSION),
});

export default {
  port: process.env.PORT,
  fetch: app.fetch,
  idleTimeout: 30,
};
