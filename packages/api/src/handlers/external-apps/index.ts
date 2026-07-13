import type { HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { OpenAPIHono } from "@hono/zod-openapi";
import { connectionsRoutes } from "./connections";
import { providersRoutes } from "./providers";

/**
 * Composite `/external-apps/*` router. Mounts the connection sub-routers:
 *
 *   GET    /external-apps/providers              ← providersRoutes
 *   POST   /external-apps/connect-session        ← connectionsRoutes
 *   POST   /external-apps/connections            ← connectionsRoutes (confirm)
 *   GET    /external-apps/connections            ← connectionsRoutes
 *   GET    /external-apps/connections/:id        ← connectionsRoutes
 *   PATCH  /external-apps/connections/:id        ← connectionsRoutes
 *   DELETE /external-apps/connections/:id        ← connectionsRoutes
 *
 * The approval flow moved to the top-level `/approvals` router — it now
 * serves every kind (plans, record writes, questions), not just external
 * apps. `/sandbox/exec` lives in `sandbox-exec.ts` and is mounted separately
 * because it carries a custom JWT auth, not the Better Auth cookie.
 */

const externalAppsRoutes = new OpenAPIHono<HonoLoggedAppType>();

externalAppsRoutes.route("/providers", providersRoutes);
// connectionsRoutes declares its own `/connect-session`, `/connections`,
// `/connections/{id}` paths internally, so it mounts at the root.
externalAppsRoutes.route("/", connectionsRoutes);

export { externalAppsRoutes };
