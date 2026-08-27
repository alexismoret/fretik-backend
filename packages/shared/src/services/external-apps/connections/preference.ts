import { and, eq, isNull } from "drizzle-orm";
import db from "../../../db";
import { externalAppConnectionPreferences } from "../../../db/schema";
import { canonicalProviderKey } from "../../../external-apps/canonical-provider-key";

/**
 * Which connection a viewer chose for a provider — on one page, or as their
 * default across pages.
 *
 * Read on the page-data path, so it is one indexed query and it never throws:
 * the preference is a shortcut past the automatic pick, and a missing or stale
 * row means "no shortcut", not "no data".
 */

/**
 * The page's own row wins over the viewer's default; neither is honoured
 * blindly — the caller checks the connection is still one they may use.
 */
export const preferredConnectionId = async (params: {
  teamId: string;
  userId: string;
  providerKey: string;
  pageId?: string;
}): Promise<string | undefined> => {
  const providerKey = canonicalProviderKey(params.providerKey);
  try {
    const rows = await db.query.externalAppConnectionPreferences.findMany({
      columns: { connectionId: true, pageId: true },
      where: {
        teamId: params.teamId,
        userId: params.userId,
        providerKey,
        ...(params.pageId !== undefined
          ? { OR: [{ pageId: params.pageId }, { pageId: { isNull: true } }] }
          : { pageId: { isNull: true } }),
      },
    });
    const forThisPage = rows.find((row) => row.pageId !== null);
    return (forThisPage ?? rows[0])?.connectionId;
  } catch (error) {
    // A shortcut that cannot be read is simply no shortcut. Letting this throw
    // would fail the DATASET — the page would show nothing at all because of a
    // convenience row, which is a far worse outcome than the automatic pick.
    console.warn(
      "[external-apps] could not read the connection preference:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
};

/**
 * Set or clear a viewer's choice. `connectionId: null` deletes the row, which
 * hands the page back to the automatic pick — that is what "use the default"
 * means, and it is why this is a delete rather than a sentinel value.
 *
 * The caller must already have checked that the viewer may USE the connection
 * (`getConnectionForCaller`): this writes, it does not authorise.
 */
export const setConnectionPreference = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  providerKey: string;
  /** The page this choice applies to; omit for the viewer's default. */
  pageId?: string;
  connectionId: string | null;
}): Promise<void> => {
  const providerKey = canonicalProviderKey(params.providerKey);
  const scope = and(
    eq(externalAppConnectionPreferences.teamId, params.teamId),
    eq(externalAppConnectionPreferences.userId, params.userId),
    eq(externalAppConnectionPreferences.providerKey, providerKey),
    params.pageId !== undefined
      ? eq(externalAppConnectionPreferences.pageId, params.pageId)
      : isNull(externalAppConnectionPreferences.pageId),
  );

  const connectionId = params.connectionId;
  if (connectionId === null) {
    await db.delete(externalAppConnectionPreferences).where(scope);
    return;
  }

  // Delete-then-insert rather than an upsert: the uniqueness this must respect
  // lives in TWO partial indexes (page-scoped and default), so there is no
  // single conflict target `ON CONFLICT` could name.
  await db.transaction(async (tx) => {
    await tx.delete(externalAppConnectionPreferences).where(scope);
    await tx.insert(externalAppConnectionPreferences).values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.userId,
      providerKey,
      pageId: params.pageId ?? null,
      connectionId,
    });
  });
};
