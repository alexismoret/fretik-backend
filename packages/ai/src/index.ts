import { errorHandler } from "@fretik/shared/lib/error-handler";
import { reclaimOrphanSandboxes } from "@fretik/shared/services/e2b/reclaim-orphans";
import { OpenAPIHono } from "@hono/zod-openapi";
import figlet from "figlet";
import { cors } from "hono/cors";

import packagejson from "../package.json";
import { chatFilesRoutes } from "./handlers/chat-files";
import { chatbotInternalRoutes, chatbotRoutes } from "./handlers/chatbot";
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

// Internal agent invocations (X-Internal-Key middleware inside)
app.route("/internal/agents/chatbot", chatbotInternalRoutes);

// Internal vectorisation endpoint for @fretik/shared vector-refresh callers.
app.route("/internal/vectorize", vectorizeRoutes);

// Internal pre-extraction endpoint — OCR + structured classification +
// entity extraction. Consumed by @fretik/shared upload pipeline.
app.route("/internal/pre-extract", preExtractRoutes);

// Load the bundled-skills catalog into memory so the system-prompt
// renderer can advertise the L1 listing (skill name + description).
// The skill bundles themselves are pushed to each conversation's
// sandbox at first init by `lib/conversation-storage.ts` — no /tmp
// materialisation here.
await loadSkillCatalog();

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
