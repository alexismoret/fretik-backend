// Compiles every Zod schema on first use (zod 4.5). Side-effect import, first
// so nothing parses ahead of it. Every HTTP request on this service is
// validated by @hono/zod-openapi, which is exactly the repeated-parse workload
// compilation is for; valid input takes the compiled path and invalid input
// falls back to the normal parser, so error reporting is unchanged.
import "zod/compile";

// Patches Zod with `.openapi()`. Side-effect import, and it MUST precede every
// `@fretik/*` import: the formatter sorts `@fretik` before `@hono`, so any
// shared module reaching `schemas/common/params` (which calls `.openapi()` at
// module load) would otherwise evaluate against an unpatched Zod and throw at
// boot. Comment-separated side-effect groups are left in place by the sorter,
// which is what makes this order enforceable.
// oxlint-disable-next-line import/no-duplicates
import "@hono/zod-openapi";

// Bootstrap external-app provider registration (side-effect import — must
// run before any route handler touches the registry).
import "@fretik/providers";

import {
  assertMigrationsCurrent,
  runMigrationsWithLock,
} from "@fretik/shared/db/migrations";
import { auth } from "@fretik/shared/lib/auth";
import { errorHandler } from "@fretik/shared/lib/error-handler";
import { globalRateLimiter } from "@fretik/shared/lib/rate-limit";
import { installExternalPageQueryExecutor } from "@fretik/shared/services/external-apps/exec/page-query";
import { OpenAPIHono } from "@hono/zod-openapi";
import figlet from "figlet";
import { getConnInfo } from "hono/bun";
import { cors } from "hono/cors";

import packagejson from "../package.json";
import { accessRoutes } from "./handlers/access";
import { accountRoutes } from "./handlers/account";
import { aiMemoryRoutes } from "./handlers/ai-memory";
import { approvalsRoutes } from "./handlers/approvals";
import { changelogRoutes } from "./handlers/changelog";
import { chatbotContextRoutes } from "./handlers/chatbot-context";
import { collectionRecordRoutes } from "./handlers/collection-records";
import { collectionSharingRoutes } from "./handlers/collection-sharing";
import { collectionSyncRoutes } from "./handlers/collection-sync";
import { collectionRoutes } from "./handlers/collections";
import { conversationRoutes } from "./handlers/conversations";
import { dashboardRoutes } from "./handlers/dashboard";
import { desktopReleaseRoutes } from "./handlers/desktop-releases";
import { documentRoutes } from "./handlers/documents";
import { externalAppsRoutes } from "./handlers/external-apps";
import { nangoWebhookRoutes } from "./handlers/external-apps/nango-webhook";
import { sandboxRoutes } from "./handlers/external-apps/sandbox-exec";
import { fieldDefinitionRoutes } from "./handlers/field-definitions";
import { folderRoutes } from "./handlers/folders";
import { invitationRoutes } from "./handlers/invitations";
import { linkTypeRoutes } from "./handlers/link-types";
import { linkRoutes } from "./handlers/links";
import { memberRoutes } from "./handlers/members";
import { organizationRoutes } from "./handlers/organization";
import { pageRoutes } from "./handlers/pages";
import { pinRoutes } from "./handlers/pins";
import { projectRoutes } from "./handlers/projects";
import { publicFormRoutes } from "./handlers/public-forms";
import { publicPageRoutes } from "./handlers/public-pages";
import { signupAccessRoutes } from "./handlers/signup-access";
import { skillsRoutes } from "./handlers/skills";
import { superAdminRoutes } from "./handlers/super-admins";
import { teamSettingsRoutes } from "./handlers/team-settings";
import { teamRoutes } from "./handlers/teams";
import { toolPoliciesRoutes } from "./handlers/tool-policies";
import { workflowRoutes } from "./handlers/workflows";
import { workspaceRoutes } from "./handlers/workspaces";

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
  await assertMigrationsCurrent("api");
}

// Page datasets may read connected apps in THIS process (the seam refuses
// everywhere the executor is not installed — a worker, a bare test).
installExternalPageQueryExecutor();

const app = new OpenAPIHono();

// Global error handler - catches all HTTPExceptions and formats as ApiError
app.onError(errorHandler);

// Cors
app.use(
  "*",
  cors({
    origin: (origin) => origin, // Accept all origins
    credentials: true,
    exposeHeaders: ["Content-Disposition", "x-filename"],
  }),
);

// Broad per-IP anti-abuse backstop (Redis-backed, shared across instances).
// Exempts `/internal/*` + `/health` so service-to-service and automatic
// traffic is never throttled; `/auth/*` keeps its own tighter Better Auth cap.
app.use("*", globalRateLimiter());

// Auth. Better Auth reads the client IP from `x-forwarded-for` (see auth.ts
// `advanced.ipAddress`). Behind a proxy (e.g. Vercel) that header is set for
// us; on a direct connection (local dev, native/Electron client) the IP lives
// only at the socket level, so the session would store no IP. Backfill it from
// the peer address when the header is absent. Cold path (login/session ops) —
// `new Request` reuses the body by reference, only the small header set is copied.
app.on(["POST", "GET"], "/auth/*", (c) => {
  const headers = new Headers(c.req.raw.headers);
  if (!headers.has("x-forwarded-for")) {
    const address = getConnInfo(c).remote.address;
    if (address) headers.set("x-forwarded-for", address);
  }
  return auth.handler(new Request(c.req.raw, { headers }));
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }, 200));

// Routes
app.route("/account", accountRoutes);
app.route("/organization", organizationRoutes);
// Who may do what: the caller's decisions, the policy, the roles grid.
app.route("/access", accessRoutes);
app.route("/workspaces", workspaceRoutes);
app.route("/members", memberRoutes);
app.route("/teams", teamRoutes);
app.route("/projects", projectRoutes);
app.route("/signup-access", signupAccessRoutes);
app.route("/super-admins", superAdminRoutes);
app.route("/document", documentRoutes);
app.route("/folder", folderRoutes);
app.route("/conversation", conversationRoutes);
app.route("/dashboard", dashboardRoutes);
app.route("/chatbot-context", chatbotContextRoutes);
app.route("/ai-memory", aiMemoryRoutes);
app.route("/field-definitions", fieldDefinitionRoutes);
app.route("/collections", collectionRoutes);
app.route("/collection-records", collectionRecordRoutes);
app.route("/collection-sharing", collectionSharingRoutes);
// Declarations that a collection (or some of its columns) is fed by a
// connected app. The runs themselves happen in @fretik/jobs.
app.route("/collection-sync", collectionSyncRoutes);
app.route("/links", linkRoutes);
app.route("/link-types", linkTypeRoutes);
app.route("/invitations", invitationRoutes);
app.route("/skills", skillsRoutes);
app.route("/external-apps", externalAppsRoutes);
app.route("/approvals", approvalsRoutes);
app.route("/tool-policies", toolPoliciesRoutes);
app.route("/team-settings", teamSettingsRoutes);
app.route("/workflows", workflowRoutes);
app.route("/pages", pageRoutes);
app.route("/pins", pinRoutes);
// Read receipts only — the product updates themselves ship with the client.
app.route("/changelog", changelogRoutes);
app.route("/forms", publicFormRoutes);
// Anonymous ingress for published pages — no auth, always answers 200.
app.route("/p", publicPageRoutes);
app.route("/desktop-releases", desktopReleaseRoutes);
app.route("/sandbox", sandboxRoutes);
// Signed ingress from our Nango instance — no session, the HMAC is the auth.
app.route("/webhooks", nangoWebhookRoutes);

// The document-processing Worker lives in @fretik/jobs (with the memory
// pipeline) — API replicas only PRODUCE onto the queue. Background CPU
// (OCR, extraction, vectorise) scales by adding jobs replicas, not API ones.

// Init log
const text = await figlet.text("fretik API");
console.log(`
---------------------------
${text}
v${VERSION}
---------------------------
`);

/**
 * `Bun.serve` closes a socket that has carried no bytes for this many seconds,
 * and it counts a request whose HANDLER is slow, not merely an idle client.
 *
 * This was 30 — never as a decision. The value has no commit that chose it and
 * no message that explains it; `@fretik/ai` inherited the same three lines and
 * its comment states the assumption out loud: "the same three lines are in
 * `api` and `jobs`, where nothing streams for minutes". `/sandbox` falsifies
 * that. It is where the agent executes external-app actions, synchronously, in
 * the request:
 *
 *  - `READ_LEASE_MS` is 70 s, and its own comment says it must exceed the
 *    longest legitimate call. Two transports already run past 30 s by design —
 *    Akanea WMS aborts at 60 s, a page dataset waits 45 s.
 *  - `run_plan` executes its operations three at a time. Twenty writes at the
 *    proxy's 25 s ceiling is minutes, and no constant we own bounds a plan's
 *    length.
 *
 * Every one of those was already dying at 30 s — not with an error the agent
 * could report, which is the part that matters: the socket simply goes, and a
 * write whose response never arrived is indistinguishable from one that never
 * happened.
 *
 * 255 is Bun's documented maximum, and the value `@fretik/ai` settled on
 * (2026-09-06) after four page builds died between 90 and 121 s with a
 * heartbeat that was supposed to prevent exactly that. The argument there
 * applies here unchanged: this bounds nothing an operator wants bounded, it
 * only decides whether a slow legitimate request fails or succeeds. `jobs`
 * keeps 30 — it serves health checks and nothing else.
 */
const SOCKET_IDLE_TIMEOUT_SECONDS = 255;

// Serve
export default {
  port: process.env.PORT,
  fetch: app.fetch,
  idleTimeout: SOCKET_IDLE_TIMEOUT_SECONDS,
};
