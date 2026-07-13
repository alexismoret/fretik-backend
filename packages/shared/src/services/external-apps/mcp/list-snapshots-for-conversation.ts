import { eq } from "drizzle-orm";
import db from "../../../db";
import { aiConversations } from "../../../db/schema";
import { isMcpConnection } from "./connection-kind";
import { getSnapshotForConnection } from "./snapshot-store";

/**
 * The compiled tool surface of one MCP connection, ready to drop into the
 * sandbox: the generated Python stub (`fretik_apps/<moduleName>.py`) and the
 * SKILL index (`skills/<providerKey>/SKILL.md`).
 */
export interface McpConnectionOverlay {
  /** Fretik provider key == SKILL directory (`notion-mcp`, custom slug). */
  providerKey: string;
  /** Python module basename (`notion_mcp`) — hyphens folded to underscores. */
  moduleName: string;
  /** Generated `fretik_apps/<moduleName>.py` source. */
  sdkPy: string;
  /** Generated `skills/<providerKey>/SKILL.md`. */
  skillMd: string;
}

/**
 * MCP tool-surface overlays for every ready MCP connection on the team that
 * owns `conversationId` — the runtime counterpart to
 * `listActiveProviderKeysForConversation` (which handles the committed
 * manifest providers). The sandbox bootstrap writes each overlay's stub +
 * SKILL alongside the base tarball so the agent can drive the connected
 * server from `python` without the tool surface entering the LLM context.
 *
 * Team-scoped (not user-scoped) for the same reason the manifest path is:
 * the sandbox is shared across the team's members, so anyone could be the
 * next message; dispatch re-resolves the caller's own connection and gates
 * access there. Deduped by `providerKey` — curated vendors share one snapshot
 * across members' connections; a `mcp-generic` server's key is unique so its
 * snapshot stays per-connection. Connections still `preparing`
 * (`toolFingerprint` NULL) yield no snapshot and are skipped.
 */
export const listMcpSnapshotsForConversation = async (
  conversationId: string,
): Promise<McpConnectionOverlay[]> => {
  const convRows = await db
    .select({ teamId: aiConversations.teamId })
    .from(aiConversations)
    .where(eq(aiConversations.id, conversationId))
    .limit(1);

  const teamId = convRows[0]?.teamId;
  if (!teamId) return [];

  const connections = await db.query.externalAppConnections.findMany({
    where: { teamId, status: "active" },
  });

  // One representative connection per provider key: curated vendors resolve
  // the same shared snapshot, so a single lookup covers every member's
  // connection; `mcp-generic` keys are unique so each is its own entry.
  const representatives = new Map<string, (typeof connections)[number]>();
  for (const connection of connections) {
    if (!isMcpConnection(connection)) continue;
    if (!representatives.has(connection.providerKey)) {
      representatives.set(connection.providerKey, connection);
    }
  }

  const overlays = await Promise.all(
    Array.from(representatives.values()).map(async (connection) => {
      const snapshot = await getSnapshotForConnection(connection);
      if (snapshot === undefined) return undefined;
      return {
        providerKey: connection.providerKey,
        // Same kebab→snake fold the codegen applies to the module name.
        moduleName: connection.providerKey.replace(/-/g, "_"),
        sdkPy: snapshot.sdkPy,
        skillMd: snapshot.skillMd,
      } satisfies McpConnectionOverlay;
    }),
  );

  return overlays.filter((o): o is McpConnectionOverlay => o !== undefined);
};
