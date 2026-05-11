import type { AiMemoryActor, AiMemoryScope } from "../../db/schema/ai-memory";

/**
 * Tenancy + identity required to scope every memory operation.
 *
 *  - `organizationId` / `teamId` come from the authenticated session
 *    (Better-Auth) or from `X-Context-*` headers on internal routes;
 *  - `userId` is the acting user — the field is required even for
 *    team-scope writes because it powers the audit trail
 *    (`createdByUserId` / `lastModifiedByUserId` / `byUserId`).
 *
 * For `scope='user'` writes, the same `userId` doubles as the file
 * owner — services force `aiMemories.userId = key.userId` and never
 * trust the model to specify another user.
 */
export interface MemoryScopeKey {
  organizationId: string;
  teamId: string;
  userId: string;
}

/**
 * Discriminates who is performing the write so the audit log can
 * distinguish agent-driven memorization from manual UI edits.
 *
 *  - `actor: "agent"` is set when the chatbot tool calls a service
 *    inside a streamed turn. `conversationId` MUST point at the
 *    `ai_conversations.id` row the model is currently streaming
 *    on — sourced from `AgentRuntimeContext.conversationId`.
 *  - `actor: "human"` is set by the API handlers wired to the
 *    settings UI. `conversationId` stays undefined (no chatbot
 *    context — the user opened the settings page directly).
 */
export interface MemoryActorContext {
  userId: string;
  actor: AiMemoryActor;
  conversationId?: string;
}

/**
 * Discriminator for view targets: a single file vs a directory listing.
 * Used internally by `view.ts` to switch the rendering format.
 */
export type ViewTargetKind = "file" | "directory";

/**
 * Parsed shape of a `/memories/<scope>/<relativePath>` input.
 * Produced by `paths.parseMemoryPath()` after validation.
 */
export interface ParsedMemoryPath {
  scope: AiMemoryScope;
  /**
   * Path inside the namespace, no leading `/`. Possibly empty
   * (root listing of the namespace).
   */
  relativePath: string;
}
