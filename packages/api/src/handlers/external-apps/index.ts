import type { HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { OpenAPIHono } from "@hono/zod-openapi";
import { approvalsRoutes } from "./approvals";
import { connectionsRoutes } from "./connections";
import { providersRoutes } from "./providers";

/**
 * Composite `/external-apps/*` router. Mounts the three sub-routers:
 *
 *   GET    /external-apps/providers              ← providersRoutes
 *   POST   /external-apps/connect-session        ← connectionsRoutes
 *   POST   /external-apps/connections            ← connectionsRoutes (confirm)
 *   GET    /external-apps/connections            ← connectionsRoutes
 *   GET    /external-apps/connections/:id        ← connectionsRoutes
 *   PATCH  /external-apps/connections/:id        ← connectionsRoutes
 *   DELETE /external-apps/connections/:id        ← connectionsRoutes
 *   GET    /external-apps/approvals/:id          ← approvalsRoutes
 *   POST   /external-apps/approvals/:id/grant    ← approvalsRoutes
 *   POST   /external-apps/approvals/:id/modify-and-grant ← approvalsRoutes
 *   POST   /external-apps/approvals/:id/reject   ← approvalsRoutes
 *
 * `/sandbox/exec` lives in `sandbox-exec.ts` and is mounted separately
 * because it carries a custom JWT auth, not the Better Auth cookie.
 */

const externalAppsRoutes = new OpenAPIHono<HonoLoggedAppType>();

externalAppsRoutes.route("/providers", providersRoutes);
// connectionsRoutes declares its own `/connect-session`, `/connections`,
// `/connections/{id}` paths internally, so it mounts at the root.
externalAppsRoutes.route("/", connectionsRoutes);
externalAppsRoutes.route("/approvals", approvalsRoutes);

export { externalAppsRoutes };
