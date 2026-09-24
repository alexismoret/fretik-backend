import type { AiMemoryScope } from "../../db/schema/ai-memory";

/**
 * Where a turn works and who writes in it: what decides which notes it
 * reads and writes.
 */
export interface MemoryPlace {
  /** The project the chat or workflow belongs to. */
  projectId?: string | undefined;
  /**
   * The person writing is not one of the team's people: they take part in
   * one of its projects, or read a chat shared with them from it.
   */
  outsideTeam?: boolean | undefined;
}

/**
 * The namespaces under `/memories/` a turn reads and writes:
 *
 * - `user`, the person's own notes, everywhere;
 * - `team`, the team's, for the team's people only: someone from elsewhere
 *   gets none of the team's own context;
 * - `project`, the project's, in its chats and workflows.
 *
 * In this order, which is the order the memory index lists them in.
 */
export const memoryNamespacesFor = (place: MemoryPlace): AiMemoryScope[] => [
  "user",
  ...(place.outsideTeam === true ? [] : (["team"] as const)),
  ...(place.projectId === undefined ? [] : (["project"] as const)),
];
