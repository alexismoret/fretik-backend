// OpenTelemetry tracing bootstrap (Langfuse). Side-effect import — MUST be
// first so the global tracer provider is registered before any model call
// creates a telemetry span. No-op when LANGFUSE_* env vars are absent.
import "./lib/langfuse";

// Bootstrap external-app provider registration (side-effect import — must
// run before any chatbot tool or sandbox-exec touches the registry).
import "@fretik/providers";

import { errorHandler } from "@fretik/shared/lib/error-handler";
import { reclaimOrphanSandboxes } from "@fretik/shared/services/e2b/reclaim-orphans";
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
import { registerOrphanCleanupCron } from "./services/chat-files/orphan-cron";
import {
  loadSkillCatalog,
  vectorizeAllBundledSkills,
} from "./skills/materialize";

const VERSION = packagejson.version;

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

// Health check
app.get("/health", (c) => c.json({ status: "ok" }, 200));

// User-facing chatbot stream (auth cookie middleware inside)
app.route("/chatbot", chatbotRoutes);

// User-facing chat-file upload / delete / download
app.route("/chatbot-files", chatFilesRoutes);

// User-facing model selection (C8) — picker menu + team defaults (cookie auth).
app.route("/model-profiles", modelProfilesRoutes);

// Internal agent invocations (X-Internal-Key middleware inside)
app.route("/internal/agents/chatbot", chatbotInternalRoutes);

// Internal vectorisation endpoint for @fretik/shared vector-refresh callers.
app.route("/internal/vectorize", vectorizeRoutes);

// Internal pre-extraction endpoint — OCR + structured classification +
// entity extraction. Consumed by @fretik/shared upload pipeline.
app.route("/internal/pre-extract", preExtractRoutes);

// Internal mention extraction for the @fretik/jobs event→graph resolver.
app.route("/internal/memory", memoryRoutes);

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
