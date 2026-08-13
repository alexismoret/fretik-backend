// OpenTelemetry tracing bootstrap (Langfuse). Side-effect import — MUST be
// first so the global tracer provider is registered before any model call
// creates a telemetry span. No-op when LANGFUSE_* env vars are absent.
import "./lib/langfuse";

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

import { errorHandler } from "@fretik/shared/lib/error-handler";
import { globalRateLimiter } from "@fretik/shared/lib/rate-limit";
import { reclaimOrphanSandboxes } from "@fretik/shared/services/e2b/reclaim-orphans";
import { installExternalPageQueryExecutor } from "@fretik/shared/services/external-apps/exec/page-query";
import { syncBundledSkillsCatalogue } from "@fretik/shared/services/skills/sync-bundled-catalogue";
import { OpenAPIHono } from "@hono/zod-openapi";
import figlet from "figlet";
import { cors } from "hono/cors";

import packagejson from "../package.json";
import { chatFilesRoutes } from "./handlers/chat-files";
import { chatbotInternalRoutes, chatbotRoutes } from "./handlers/chatbot";
import { memoryRoutes } from "./handlers/memory";
import { modelProfilesRoutes } from "./handlers/model-profiles";
import { preExtractRoutes } from "./handlers/pre-extract";
import { vectorizeRoutes } from "./handlers/vectorize";
import { workflowTriggerRoutes } from "./handlers/workflow";
import { workflowTranscriptRoutes } from "./handlers/workflow-transcript";
import { registerOrphanCleanupCron } from "./services/chat-files/orphan-cron";
import { subscribeConversationTaskResumes } from "./services/conversation-tasks/subscribe-resume";
import { backfillWorkflowVectors } from "./services/vectorize/workflows";
import {
  loadSkillCatalog,
  vectorizeAllBundledSkills,
} from "./skills/materialize";

const VERSION = packagejson.version;

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

// Index workflows that predate the discovery feature, so the assistant can
// find them from a plain request. Selects only un-indexed ones, so this is a
// no-op from the second boot on. Fire-and-forget — never blocks boot.
void backfillWorkflowVectors()
  .then(({ indexed }) => {
    if (indexed > 0) {
      console.log(
        `[boot] indexed ${indexed.toString()} workflow(s) for discovery`,
      );
    }
  })
  .catch((err: unknown) => {
    console.error(
      "[boot] workflow vectorize backfill failed:",
      err instanceof Error ? err.message : err,
    );
  });

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

// Init banner
const text = await figlet.text("fretik AI");
console.log(`
---------------------------
${text}
v${VERSION}
---------------------------
`);

export default {
  port: process.env.PORT,
  fetch: app.fetch,
  idleTimeout: 30,
};
