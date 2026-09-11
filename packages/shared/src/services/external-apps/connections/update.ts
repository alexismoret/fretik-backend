import { eq } from "drizzle-orm";
import { z } from "zod";
import db from "../../../db";
import {
  type ExternalAppConcurrencyMode,
  type ExternalAppConnection,
  type ExternalAppConnectionStatus,
  externalAppConnections,
} from "../../../db/schema";
import { buildConnectionOptionsZod } from "../../../external-apps/connection-options-validator";
import { getProvider } from "../../../external-apps/registry";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import type { ConnectionScope } from "../../../schemas/external-apps";
import {
  type ToolPolicyLevel,
  toolPolicyLevelSchema,
} from "../../../schemas/tool-policies";
import { isMcpConnection } from "../mcp/connection-kind";
import { getSnapshotForConnection } from "../mcp/snapshot-store";
import { invalidateConnectionCaches } from "./epoch";
import { getConnectionForCaller } from "./get-by-id";

/**
 * The names a connection's `actionPolicies` may key on. An MCP connection has
 * NO registry entry — its provider key is a minted slug and its action surface
 * lives in the introspected snapshot — so validating it against the manifest
 * registry returned `404 Unknown provider` for every MCP connection, while the
 * settings UI happily rendered the very rows the PATCH then refused. Same
 * source as the read path (`toConnectionDto`) and the dispatch path
 * (`exec/mcp-read.ts`): the snapshot descriptor.
 */
const resolveActionNames = async (
  connection: ExternalAppConnection,
): Promise<Set<string>> => {
  if (isMcpConnection(connection)) {
    const snapshot = await getSnapshotForConnection(connection);
    if (snapshot === undefined) {
      return throwHttpError(409, {
        code: ERROR_CODES.EXTERNAL_APP_MCP_NOT_READY,
        message: `Connection "${connection.displayName}" has no tool list yet — its server hasn't been introspected. Retry once it is ready.`,
      });
    }
    return new Set(snapshot.descriptor.actions.map((a) => a.name));
  }
  const provider = getProvider(connection.providerKey);
  if (provider === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
      message: `Unknown provider: ${connection.providerKey}`,
    });
  }
  return new Set(provider.manifest.actions.map((a) => a.name));
};

/**
 * Rename a connection, flip its status (`active` ↔ `disabled`), re-scope it
 * (`team` ↔ `user`) or update its `options`. Only the original creator or
 * members with team-wide access can update — `getConnectionForCaller` already
 * enforces team + user-scope visibility, so anyone who can see the connection
 * can update it.
 *
 * Status `error` is set by the dispatcher itself on a Nango 401/403, not
 * by users — it's accepted here for completeness (admins flipping back
 * to `active` after a manual recovery).
 *
 * `scope` moves the row between shared (`user_id` NULL) and private. Taking a
 * SHARED connection private takes it away from everyone else, so it is gated on
 * being its creator or an org admin; sharing a PRIVATE one needs no gate — only
 * its owner can see it in the first place, so only its owner can get here.
 *
 * `options` is treated as a partial patch: provided keys overwrite the
 * existing JSONB, omitted keys are preserved. The resulting merged object
 * is then re-validated against the provider's `connectionOptions`
 * descriptor as a whole, so partial updates can never leave the
 * connection in an invalid state.
 */
export const updateConnection = async (params: {
  id: string;
  teamId: string;
  userId: string;
  displayName?: string;
  status?: ExternalAppConnectionStatus;
  /** `team` = shared with the whole team, `user` = private to the caller. */
  scope?: ConnectionScope;
  options?: Record<string, unknown>;
  /** Sparse per-action policy patch (level sets, `null` resets to default). */
  actionPolicies?: Record<string, ToolPolicyLevel | null>;
  /** How many calls this account tolerates at once; `null` follows the manifest. */
  concurrencyMode?: ExternalAppConcurrencyMode | null;
  /** Whether the caller is an org admin — required to edit `actionPolicies` on
   * a TEAM-scoped connection (any member can see it, only admins may change its
   * permissions). Personal connections are owner-only via `getConnectionForCaller`. */
  isOrgAdmin?: boolean;
}): Promise<ExternalAppConnection> => {
  const current = await getConnectionForCaller(
    params.id,
    params.teamId,
    params.userId,
  );

  const patch: Partial<ExternalAppConnection> = { updatedAt: new Date() };
  if (params.displayName !== undefined) patch.displayName = params.displayName;
  if (params.status !== undefined) {
    patch.status = params.status;
    if (params.status !== "error") patch.lastErrorMessage = null;
  }

  if (params.scope !== undefined) {
    const currentScope: ConnectionScope =
      current.userId === null ? "team" : "user";
    if (params.scope !== currentScope) {
      // Un-sharing is the only direction that takes something away from other
      // people, so it is the only one that needs a gate.
      if (
        params.scope === "user" &&
        current.createdByUserId !== params.userId &&
        params.isOrgAdmin !== true
      ) {
        return throwHttpError(403, {
          code: ERROR_CODES.FORBIDDEN,
          message:
            "Only the member who connected this app, or an admin, can make it personal.",
        });
      }
      patch.userId = params.scope === "team" ? null : params.userId;
    }
  }

  if (params.concurrencyMode !== undefined) {
    // Same gate as the policies below: on a shared connection this decides how
    // hard the WHOLE team may push one account, so it is not a per-member knob.
    if (current.userId === null && params.isOrgAdmin !== true) {
      return throwHttpError(403, {
        code: ERROR_CODES.FORBIDDEN,
        message: "Only an admin can change a team connection's concurrency.",
      });
    }
    patch.concurrencyMode = params.concurrencyMode;
  }

  if (params.actionPolicies !== undefined) {
    // Team-scoped connection: only admins may change its permissions.
    if (current.userId === null && params.isOrgAdmin !== true) {
      return throwHttpError(403, {
        code: ERROR_CODES.FORBIDDEN,
        message: "Only an admin can change a team connection's permissions.",
      });
    }
    const actionNames = await resolveActionNames(current);
    const merged: Record<string, ToolPolicyLevel> = {
      ...(current.actionPolicies ?? {}),
    };
    for (const [name, level] of Object.entries(params.actionPolicies)) {
      if (!actionNames.has(name)) {
        return throwHttpError(400, {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: `Unknown action "${name}" for provider ${current.providerKey}`,
        });
      }
      if (level === null) {
        delete merged[name];
        continue;
      }
      const parsed = toolPolicyLevelSchema.safeParse(level);
      if (!parsed.success) {
        return throwHttpError(400, {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: `Invalid policy level for action "${name}"`,
        });
      }
      merged[name] = parsed.data;
    }
    patch.actionPolicies = merged;
  }

  if (params.options !== undefined) {
    // `connectionOptions` is a manifest descriptor; an MCP connection has no
    // manifest, so there is nothing to validate against — say that, rather than
    // letting `getProvider` below report its key as unknown.
    if (isMcpConnection(current)) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_MCP_UNSUPPORTED,
        message: "An MCP connection accepts no connection options.",
      });
    }
    const provider = getProvider(current.providerKey);
    if (provider === undefined) {
      return throwHttpError(404, {
        code: ERROR_CODES.EXTERNAL_APP_PROVIDER_NOT_FOUND,
        message: `Unknown provider: ${current.providerKey}`,
      });
    }
    if (provider.manifest.connectionOptions === undefined) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
        message: `Provider ${current.providerKey} does not accept connection options.`,
      });
    }
    const merged: Record<string, unknown> = {
      ...(current.options ?? {}),
      ...params.options,
    };
    const schema = buildConnectionOptionsZod(
      provider.manifest.connectionOptions,
    );
    const parsed = schema.safeParse(merged);
    if (!parsed.success) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_OPTIONS,
        message: "Invalid connection options",
        details: z.prettifyError(parsed.error),
      });
    }
    patch.options = parsed.data;
  }

  const [row] = await db
    .update(externalAppConnections)
    .set(patch)
    .where(eq(externalAppConnections.id, params.id))
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to update connection",
    });
  }
  // Every field this patches changes what a page gets: `status` decides whether
  // the connection resolves at all, `actionPolicies` whether an operation may
  // run, `options` what the call carries. The answers cached under the old
  // settings go with them.
  await invalidateConnectionCaches({ connection: row, purgeAnswers: true });
  return row;
};
