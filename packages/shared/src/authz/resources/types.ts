import type {
  AccessLevel,
  AccessResourceType,
  ShareablePrincipalType,
} from "../../schemas/access";
import type { ResourceNode } from "../rules";

/**
 * A node as an adapter returns it: the facts the rules read, plus what a
 * person needs to recognise the resource in a refusal or a share dialog.
 */
export interface LoadedNode extends ResourceNode {
  readonly name: string;
}

/**
 * One resource type, as the engine sees it. Each adapter knows where its
 * type keeps the facts the rules need — its owner, its container, whether it
 * is restricted, its grants (explicit, and the older tables that still hold
 * some) — and turns rows into `ResourceNode`s. The rules themselves never
 * change per type; only the reading of them does.
 */
export interface ResourceAdapter {
  readonly type: AccessResourceType;
  /** The levels the share dialog offers on this type, weakest first. */
  readonly offeredLevels: readonly AccessLevel[];
  /** Who the share dialog lets a person share this type with. */
  readonly shareablePrincipals: readonly ShareablePrincipalType[];
  /**
   * The nodes of these ids that exist, keyed by id. Missing ids are simply
   * absent: the caller answers them like invisible ones (404).
   */
  readonly loadNodes: (
    ids: readonly string[],
  ) => Promise<Map<string, LoadedNode>>;
}
