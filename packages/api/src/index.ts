// Bootstrap external-app provider registration (side-effect import — must
// run before any route handler touches the registry).
import "@fretik/providers";

import { auth } from "@fretik/shared/lib/auth";
import { errorHandler } from "@fretik/shared/lib/error-handler";
import { OpenAPIHono } from "@hono/zod-openapi";
import figlet from "figlet";
import { cors } from "hono/cors";

import packagejson from "../package.json";
import { aiMemoryRoutes } from "./handlers/ai-memory";
import { chatbotContextRoutes } from "./handlers/chatbot-context";
import { conversationRoutes } from "./handlers/conversations";
import { documentRoutes } from "./handlers/documents";
import { entityRoutes } from "./handlers/entities";
import { externalAppsRoutes } from "./handlers/external-apps";
import { sandboxRoutes } from "./handlers/external-apps/sandbox-exec";
import { fieldDefinitionRoutes } from "./handlers/field-definitions";
import { fieldTemplateRoutes } from "./handlers/field-templates";
import { folderRoutes } from "./handlers/folders";
import { labelRoutes } from "./handlers/labels";
import { skillsRoutes } from "./handlers/skills";

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

// Auth
app.on(["POST", "GET"], "/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }, 200));

// Routes
app.route("/document", documentRoutes);
app.route("/entity", entityRoutes);
app.route("/folder", folderRoutes);
app.route("/conversation", conversationRoutes);
app.route("/chatbot-context", chatbotContextRoutes);
app.route("/ai-memory", aiMemoryRoutes);
app.route("/field-definitions", fieldDefinitionRoutes);
app.route("/field-templates", fieldTemplateRoutes);
app.route("/label", labelRoutes);
app.route("/skills", skillsRoutes);
app.route("/external-apps", externalAppsRoutes);
app.route("/sandbox", sandboxRoutes);

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
