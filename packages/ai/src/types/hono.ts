import type { HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import type { AgentRuntimeContextBase } from "../agents/shared/agent-builder";

/**
 * Variables available to handlers protected by the Better Auth cookie.
 * Same shape as @fretik/api's HonoLoggedAppType — re-exported for clarity.
 */
export type { HonoLoggedAppType };

/**
 * Variables available to handlers protected by the X-Internal-Key middleware.
 * Used by /internal/* routes called by api/worker where the caller passes
 * team/org/user context explicitly via X-Context-* headers.
 *
 * The internal middleware only has access to the pure-data fields of
 * the runtime context — the per-request manager (`dynamicToolManager`)
 * is instantiated later by the agent's `prepareCall`
 * hook. See `agents/shared/agent-builder.ts`.
 */
export type HonoInternalAppType = {
  Variables: {
    context: AgentRuntimeContextBase;
  };
};
