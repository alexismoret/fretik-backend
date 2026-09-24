import { z } from "zod";
import type { AccessLevel, AccessResourceType } from "../schemas/access";
import { atLeast } from "./levels";
import type { Principal } from "./principal";
import { throwNotVisible, throwResourceRefusal } from "./refusals";
import { pageAdapter, workflowAdapter } from "./resources/content";
import { conversationAdapter } from "./resources/conversation";
import { documentAdapter, folderAdapter } from "./resources/drive";
import { collectionAdapter, projectAdapter } from "./resources/structure";
import type { LoadedNode, ResourceAdapter } from "./resources/types";
import { computeLevel } from "./rules";

/**
 * The engine's entry points for ONE resource (or a batch of one type): what
 * level does this person have on it, and the gate every route and tool goes
 * through before acting.
 *
 * Lists do not come through here — filtering thousands of rows one decision
 * at a time would be a loop over the database; they use the SQL predicates of
 * `resources/sql.ts`, which the tests hold to the same answers as the rules.
 */

/** The resource types the engine decides. Connections are decided by capabilities. */
export type EngineResourceType = Exclude<AccessResourceType, "connection">;

const ADAPTERS: Record<EngineResourceType, ResourceAdapter> = {
  folder: folderAdapter,
  document: documentAdapter,
  page: pageAdapter,
  workflow: workflowAdapter,
  conversation: conversationAdapter,
  collection: collectionAdapter,
  project: projectAdapter,
};

export const adapterFor = (type: EngineResourceType): ResourceAdapter =>
  ADAPTERS[type];

export const isEngineResourceType = (
  type: AccessResourceType,
): type is EngineResourceType => type !== "connection";

export interface ResolvedResource {
  readonly node: LoadedNode;
  /** The person's effective level. Full for a system principal. */
  readonly level: AccessLevel;
}

const uuid = z.uuid();

/**
 * Every resource of `ids` the principal can see, with their level. An id that
 * is malformed, missing, in another organization or simply not visible is
 * absent — the four are indistinguishable on purpose.
 */
export const resolveAccessMany = async (
  principal: Principal,
  type: EngineResourceType,
  ids: readonly string[],
): Promise<Map<string, ResolvedResource>> => {
  const wellFormed = ids.filter((id) => uuid.safeParse(id).success);
  const nodes = await ADAPTERS[type].loadNodes(wellFormed);
  const resolved = new Map<string, ResolvedResource>();
  for (const [id, node] of nodes) {
    const level =
      principal.kind === "system" ? "full" : computeLevel(principal, node);
    if (level !== null) resolved.set(id, { node, level });
  }
  return resolved;
};

/** One resource, or null when the principal cannot see it. */
export const resolveAccess = async (
  principal: Principal,
  type: EngineResourceType,
  id: string,
): Promise<ResolvedResource | null> =>
  (await resolveAccessMany(principal, type, [id])).get(id) ?? null;

/**
 * THE gate. The resource must be visible — otherwise 404, like one that does
 * not exist — and the person's level must reach `required` — otherwise 403,
 * saying why and whom to ask. Returns the resource, whose `node.teamId` is the
 * team the caller must scope its service call to: an item shared from another
 * team is served from ITS team, never re-scoped to the caller's.
 */
export const requireAccess = async (input: {
  principal: Principal;
  type: EngineResourceType;
  id: string;
  required: AccessLevel;
  /** What to call the resource in a 404 ("Page not found"). */
  notFoundMessage?: string;
}): Promise<ResolvedResource> => {
  const resolved = await resolveAccess(input.principal, input.type, input.id);
  if (!resolved) return throwNotVisible(input.notFoundMessage);
  if (atLeast(resolved.level, input.required)) return resolved;
  if (input.principal.kind === "system") return resolved;
  return throwResourceRefusal({
    principal: input.principal,
    resource: {
      type: input.type,
      id: input.id,
      ownerUserId: resolved.node.ownerUserId,
      teamId: resolved.node.teamId,
    },
    required: input.required,
    current: resolved.level,
  });
};
