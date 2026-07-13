import { and, eq, isNull } from "drizzle-orm";
import db from "../../../db";
import type {
  ExternalAppConnection,
  ExternalAppToolSnapshot,
  NewExternalAppToolSnapshot,
} from "../../../db/schema";
import {
  externalAppConnections,
  externalAppToolSnapshots,
} from "../../../db/schema";

/**
 * Persistence for MCP tool snapshots — the compiled tool surface (descriptor +
 * generated stub + SKILL) keyed by fingerprint. Curated vendors share one row
 * per `(providerKey, fingerprint)`; a team's `mcp-generic` server keys by
 * `(connectionId, fingerprint)` so its tool list never leaks across tenants.
 *
 * Snapshots are content-immutable (same fingerprint ⇒ same tools), so writes
 * are get-or-insert; only `polishedAt` (the LLM enrichment) mutates later.
 */

/** Look up a snapshot by its scope (curated shared vs custom per-connection). */
export const findToolSnapshot = async (params: {
  providerKey: string;
  fingerprint: string;
  connectionId: string | null;
}): Promise<ExternalAppToolSnapshot | undefined> => {
  const rows = await db
    .select()
    .from(externalAppToolSnapshots)
    .where(
      and(
        eq(externalAppToolSnapshots.providerKey, params.providerKey),
        eq(externalAppToolSnapshots.fingerprint, params.fingerprint),
        params.connectionId === null
          ? isNull(externalAppToolSnapshots.connectionId)
          : eq(externalAppToolSnapshots.connectionId, params.connectionId),
      ),
    )
    .limit(1);
  return rows[0];
};

/** Insert a snapshot if this fingerprint isn't stored yet; return the row. */
export const upsertToolSnapshot = async (
  row: NewExternalAppToolSnapshot,
): Promise<ExternalAppToolSnapshot> => {
  const existing = await findToolSnapshot({
    providerKey: row.providerKey,
    fingerprint: row.fingerprint,
    connectionId: row.connectionId ?? null,
  });
  if (existing !== undefined) return existing;

  const [inserted] = await db
    .insert(externalAppToolSnapshots)
    .values(row)
    .returning();
  if (inserted === undefined) {
    throw new Error("Failed to persist MCP tool snapshot");
  }
  return inserted;
};

/** Point a connection at the snapshot fingerprint it should use. A successful
 * introspection also clears any stale `lastErrorMessage` from a prior failure —
 * a fresh snapshot means the tools loaded, so the error is no longer true. */
export const setConnectionToolFingerprint = async (
  connectionId: string,
  fingerprint: string,
): Promise<void> => {
  await db
    .update(externalAppConnections)
    .set({ toolFingerprint: fingerprint, lastErrorMessage: null })
    .where(eq(externalAppConnections.id, connectionId));
};

/**
 * Record an MCP introspection failure on the connection. The row stays `active`
 * (OAuth succeeded — the connection authenticates fine) but its tools never
 * loaded: `toolFingerprint` stays NULL and `lastErrorMessage` explains why, so
 * the DTO can report `toolStatus: "error"` and the agent prompt can flag it as
 * unavailable instead of silently offering a broken app.
 */
export const recordMcpIntrospectionError = async (
  connectionId: string,
  message: string,
): Promise<void> => {
  await db
    .update(externalAppConnections)
    .set({ lastErrorMessage: message.slice(0, 2000) })
    .where(eq(externalAppConnections.id, connectionId));
};

/**
 * Resolve the snapshot a connection currently uses. Returns `undefined` when
 * the connection hasn't been introspected yet (`toolFingerprint` NULL —
 * "preparing").
 */
export const getSnapshotForConnection = async (
  connection: Pick<
    ExternalAppConnection,
    "id" | "providerKey" | "toolFingerprint"
  >,
): Promise<ExternalAppToolSnapshot | undefined> => {
  if (connection.toolFingerprint === null) return undefined;
  // Every MCP connection is a custom server now (curated removed): its snapshot
  // is scoped by connectionId so one team's tool list never resolves another's.
  return findToolSnapshot({
    providerKey: connection.providerKey,
    fingerprint: connection.toolFingerprint,
    connectionId: connection.id,
  });
};
