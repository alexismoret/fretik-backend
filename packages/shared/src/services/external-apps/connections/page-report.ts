import { getProvider } from "../../../external-apps/registry";
import type {
  PageConnectionState,
  PageDefinition,
} from "../../../schemas/pages";
import { resolvePageConnection } from "./resolve-for-page";

/**
 * What every connected app this page uses is doing FOR THIS VIEWER: which
 * account it reads through, why that one, and what to do when it reads through
 * none.
 *
 * It exists because the page itself cannot say any of that. A dataset degrades
 * to `needs_connection` and the page renders a prompt — correct per widget, and
 * silent about the thing the reader actually needs to know: whether the team is
 * connected and only they are not, whether the connection is there but broken,
 * or whether they have two accounts and are looking at the wrong one. A user
 * spent a session stuck on exactly that, told to connect an app their team had
 * been connected to all along.
 *
 * Grouped by APP rather than by dataset: a dashboard declares one dataset per
 * widget, so per-dataset rows would repeat the same sentence six times.
 *
 * Resolution is recomputed here rather than collected from the datasets. It is
 * deterministic on the same inputs, so it agrees with what they did, and it
 * also answers for a page whose data has not run — which is what the settings
 * panel needs.
 */
export const buildPageConnectionReport = async (params: {
  definition: PageDefinition;
  teamId: string;
  userId: string;
  pageId: string;
}): Promise<PageConnectionState[]> => {
  /** One entry per (pin | provider), with the ids that led to it. */
  const named = new Map<
    string,
    {
      connectionId?: string;
      providerKey?: string;
      datasetIds: string[];
      operationIds: string[];
    }
  >();
  const remember = (
    connectionId: string | undefined,
    providerKey: string | undefined,
    kind: "dataset" | "operation",
    id: string,
  ): void => {
    if (connectionId === undefined && providerKey === undefined) return;
    const key = connectionId ?? `p:${providerKey ?? ""}`;
    const entry = named.get(key) ?? {
      ...(connectionId !== undefined ? { connectionId } : {}),
      ...(providerKey !== undefined ? { providerKey } : {}),
      datasetIds: [],
      operationIds: [],
    };
    if (kind === "dataset") entry.datasetIds.push(id);
    else entry.operationIds.push(id);
    named.set(key, entry);
  };

  for (const dataset of params.definition.datasets) {
    if (dataset.kind !== "external") continue;
    remember(dataset.connectionId, dataset.providerKey, "dataset", dataset.id);
  }
  for (const operation of params.definition.operations) {
    if (operation.kind !== "app") continue;
    remember(
      operation.connectionId,
      operation.providerKey,
      "operation",
      operation.id,
    );
  }
  if (named.size === 0) return [];

  const states: PageConnectionState[] = [];
  for (const entry of named.values()) {
    // Sequential on purpose: a page names one or two apps, and each resolution
    // is two indexed queries. A fan-out here would buy nothing measurable.
    // eslint-disable-next-line no-await-in-loop -- at most a couple of apps
    const resolution = await resolvePageConnection({
      teamId: params.teamId,
      userId: params.userId,
      pageId: params.pageId,
      ...(entry.connectionId !== undefined
        ? { connectionId: entry.connectionId }
        : {}),
      ...(entry.providerKey !== undefined
        ? { providerKey: entry.providerKey }
        : {}),
    });

    const providerKey =
      resolution.status === "ok"
        ? resolution.connection.providerKey
        : resolution.status === "needs_connection"
          ? resolution.providerKey
          : (entry.providerKey ?? "");
    const appName =
      getProvider(providerKey)?.manifest.displayName ??
      (resolution.status === "ok"
        ? resolution.connection.displayName
        : providerKey);

    const shared = {
      providerKey,
      appName,
      datasetIds: entry.datasetIds,
      operationIds: entry.operationIds,
    };

    if (resolution.status === "error") {
      states.push({
        ...shared,
        status: "error",
        candidates: [],
        reason: resolution.message,
        // A pinned connection is the author's decision; nothing the viewer
        // picks can override it, so the panel must not offer a switch.
        pinned: entry.connectionId !== undefined,
      });
      continue;
    }
    if (resolution.status === "needs_connection") {
      states.push({
        ...shared,
        status: "needs_connection",
        candidates: resolution.candidates,
        reason: resolution.reason,
        pinned: entry.connectionId !== undefined,
      });
      continue;
    }
    states.push({
      ...shared,
      // Several usable accounts and the page did not name one: the pick was
      // made for the viewer, and saying so is what turns a silent default into
      // an offer to change it.
      status:
        resolution.candidates.filter((row) => row.status === "active").length >
        1
          ? "ambiguous"
          : "ok",
      using: {
        id: resolution.connection.id,
        displayName: resolution.connection.displayName,
        scope: resolution.connection.userId === null ? "team" : "user",
      },
      chosenBy: resolution.chosenBy,
      candidates: resolution.candidates,
      pinned: entry.connectionId !== undefined,
    });
  }
  return states;
};
