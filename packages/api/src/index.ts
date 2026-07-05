// Bootstrap external-app provider registration (side-effect import — must
// run before any route handler touches the registry).
import "@fretik/providers";

import { auth } from "@fretik/shared/lib/auth";
import { errorHandler } from "@fretik/shared/lib/error-handler";
import { OpenAPIHono } from "@hono/zod-openapi";
import figlet from "figlet";
import { getConnInfo } from "hono/bun";
import { cors } from "hono/cors";

import packagejson from "../package.json";
import { accountRoutes } from "./handlers/account";
import { aiMemoryRoutes } from "./handlers/ai-memory";
import { chatbotContextRoutes } from "./handlers/chatbot-context";
import { conversationRoutes } from "./handlers/conversations";
import { documentRoutes } from "./handlers/documents";
import { externalAppsRoutes } from "./handlers/external-apps";
import { sandboxRoutes } from "./handlers/external-apps/sandbox-exec";
import { fieldDefinitionRoutes } from "./handlers/field-definitions";
import { folderRoutes } from "./handlers/folders";
import { invitationRoutes } from "./handlers/invitations";
import { linkTypeRoutes } from "./handlers/link-types";
import { linkRoutes } from "./handlers/links";
import { objectRecordRoutes } from "./handlers/object-records";
import { objectSharingRoutes } from "./handlers/object-sharing";
import { objectTypeRoutes } from "./handlers/object-types";
import { organizationRoutes } from "./handlers/organization";
import { signupAccessRoutes } from "./handlers/signup-access";
import { skillsRoutes } from "./handlers/skills";
import { superAdminRoutes } from "./handlers/super-admins";

const VERSION = packagejson.version;

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
app.route("/signup-access", signupAccessRoutes);
app.route("/super-admins", superAdminRoutes);
app.route("/document", documentRoutes);
app.route("/folder", folderRoutes);
app.route("/conversation", conversationRoutes);
app.route("/chatbot-context", chatbotContextRoutes);
app.route("/ai-memory", aiMemoryRoutes);
app.route("/field-definitions", fieldDefinitionRoutes);
app.route("/object-types", objectTypeRoutes);
app.route("/objects", objectRecordRoutes);
app.route("/object-sharing", objectSharingRoutes);
app.route("/links", linkRoutes);
app.route("/link-types", linkTypeRoutes);
app.route("/invitations", invitationRoutes);
app.route("/skills", skillsRoutes);
app.route("/external-apps", externalAppsRoutes);
app.route("/sandbox", sandboxRoutes);

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

// Serve
export default {
  port: process.env.PORT,
  fetch: app.fetch,
  idleTimeout: 30,
};
