import { parseApiError } from "@fretik/shared/schemas/errors";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { deleteMemory } from "@fretik/shared/services/ai-memory/delete";
import { overwriteMemory } from "@fretik/shared/services/ai-memory/overwrite";
import {
  formatMemoryPath,
  parseMemoryPath,
} from "@fretik/shared/services/ai-memory/paths";
import { renameMemory } from "@fretik/shared/services/ai-memory/rename";
import type {
  MemoryActorContext,
  MemoryScopeKey,
} from "@fretik/shared/services/ai-memory/types";
import { viewMemory } from "@fretik/shared/services/ai-memory/view";
import { tool } from "ai";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../agents/shared/runtime-context";

/**
 * `memory` — agent-curated knowledge store under `/memories/`.
 * Inspired by Anthropic's `memory_20250818` but pruned for MiniMax
 * M2.7 reliability and integrated with the unified `ai_vectors`
 * RAG store (`searchKnowledge` indexes every memory write):
 *
 *  - **5 commands** (`view`, `create`, `overwrite`, `delete`,
 *    `rename`). No `str_replace` / `insert` — the model updates
 *    a file via `view → overwrite` (atomic upsert in SQL).
 *  - **2 namespaces**: `/memories/user/` (private to the current
 *    user) and `/memories/team/` (shared across the team, every
 *    write audited).
 *  - **Discovery via RAG**: writes are vectorised into `ai_vectors`
 *    with `[TEAM_MEMORY]` / `[USER_MEMORY]` contextual prefixes —
 *    `searchKnowledge` is the canonical way to find existing entries
 *    before creating a new file. The previous `grep` command is gone.
 */
const MEMORY_TOOL_DESCRIPTION = [
  "Persistent file-system: `/memories/user/...` (private) + `/memories/team/...` (shared, audited). Write generic, repeatable business knowledge — processes, conventions, preferences, durable contacts. NEVER write file-specific data (invoice numbers, line items, names from a single document), conversation summaries, or one-off facts.",
  "",
  "Five commands routed via `command`:",
  "",
  "- `view` — read a file (line-numbered) or list a directory (depth-2 + size). Optional `view_range:[start,end]` (1-indexed inclusive).",
  "- `create` — create a new file with `file_text`. FAILS if it already exists; use `overwrite` to replace.",
  "- `overwrite` — atomic upsert (creates or replaces full content). Your update path (no `str_replace`).",
  "- `delete` — remove a file. Logged in the audit history.",
  "- `rename` — move within the SAME namespace via `old_path` / `new_path`. Cross-namespace renames rejected.",
  "",
  "**Avoiding duplicates**: `create` returns an 'already exists' error if the path is taken — retry with `overwrite` and merge content. You don't need to `searchKnowledge` first on every write; the error is cheap. Use `searchKnowledge({ filters: { sourceTypes: ['memories'] } })` ahead of time only when you suspect a similar topic might be stored under a different path.",
  "",
  "**Body format** for `file_text`: lead with the rule or observation in plain language, then `**When to apply:**` (the trigger / context) and `**What to do:**` (the steps or rule) lines. This makes the file actionable on retrieval without re-reading the original conversation.",
  "",
  "**Path conventions** (suggestions, NOT enforced types — adapt to existing paths discovered via `searchKnowledge`):",
  "- `team/processes/<slug>.md` — repeatable workflows.",
  "- `team/conventions/<slug>.md` — team rules, defaults, format preferences.",
  "- `team/clients/<slug>.md`, `team/carriers/<slug>.md` — durable info on a specific entity.",
  "- `user/preferences.md` — personal preferences (private to current user).",
  "",
  "Errors return `{error, code}`. See `<memory_protocol>` in the system prompt for when to save automatically vs propose via `askUserQuestion`.",
].join("\n");

/**
 * Flat input schema with a `command` enum + per-command optional
 * fields. Originally a `z.discriminatedUnion`, but that compiles to a
 * top-level `oneOf` JSON schema which strict providers (notably
 * SiliconFlow on OpenRouter) reject with
 * `schema must be a JSON Schema of 'type: "object"'`. Keeping a
 * single flat object with descriptive `.describe()` hints + the
 * verbose tool description preserves the model's UX; per-command
 * requirements are enforced at runtime by `requireFieldsForCommand`
 * inside `execute`.
 */
const MemoryInputSchema = z.object({
  command: z
    .enum(["view", "create", "overwrite", "delete", "rename"])
    .describe("Memory operation to perform."),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path under /memories/. Required for view, create, overwrite, delete.",
    ),
  // `z.array(...).length(2)` instead of `z.tuple([...])`: the JSON
  // Schema emitted by zod-to-json-schema for `tuple` uses the legacy
  // draft-07 form `items: [<schema>, <schema>]`, which xAI / Grok
  // rejects as `'items' must be a schema (object or boolean), not an
  // array. Use 'prefixItems' instead.` (xAI uses 2020-12). Switching
  // to a fixed-length array of integers compiles to a portable
  // `{ type: "array", items: {…}, minItems: 2, maxItems: 2 }` accepted
  // by every provider — same runtime semantics, looser ordering.
  view_range: z
    .array(z.number().int().min(1))
    .length(2)
    .optional()
    .describe(
      "view only — [start, end] 1-indexed inclusive line range for files. Ignored on directories.",
    ),
  file_text: z
    .string()
    .optional()
    .describe(
      "create / overwrite only — full file contents (markdown / plain text).",
    ),
  old_path: z
    .string()
    .min(1)
    .optional()
    .describe("rename only — current absolute path under /memories/."),
  new_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "rename only — new absolute path. Must be in the same namespace (user ↔ team renames are rejected).",
    ),
});

type MemoryInput = z.infer<typeof MemoryInputSchema>;

const requireFieldsForCommand = (
  input: MemoryInput,
):
  | { ok: true }
  | { ok: false; error: string; code: "MEMORY_INVALID_INPUT" } => {
  const missing = (field: string) => ({
    ok: false as const,
    error: `memory.${input.command} requires '${field}'`,
    code: "MEMORY_INVALID_INPUT" as const,
  });
  switch (input.command) {
    case "view":
    case "delete":
      return input.path ? { ok: true } : missing("path");
    case "create":
    case "overwrite":
      if (!input.path) return missing("path");
      if (input.file_text === undefined) return missing("file_text");
      return { ok: true };
    case "rename":
      if (!input.old_path) return missing("old_path");
      if (!input.new_path) return missing("new_path");
      return { ok: true };
  }
};

/**
 * Lift a thrown `HTTPException` (from the shared services) into the
 * `{error, code}` envelope the agent reads. Falls back to a
 * descriptive `INTERNAL_ERROR` so unknown failures still surface
 * with a usable hint instead of silently 500-ing the stream.
 */
const liftError = (err: unknown): { error: string; code: string } => {
  if (err instanceof HTTPException) {
    const parsed = parseApiError(err.message);
    if (parsed) {
      return {
        error: parsed.message ?? "Memory operation failed",
        code: parsed.code,
      };
    }
    return { error: err.message, code: "MEMORY_HTTP_ERROR" };
  }
  return {
    error: err instanceof Error ? err.message : "Unknown error",
    code: "INTERNAL_ERROR",
  };
};

/**
 * Build the per-call scope + actor context from the runtime context.
 * Memory writes require a real `userId` (audit trail); when the
 * runtime context is missing one (e.g. internal route without an
 * authenticated user), we surface a clear `MEMORY_REQUIRES_USER`
 * error instead of silently mis-attributing the write.
 */
const buildContexts = (
  ctx: AgentRuntimeContext,
):
  | { ok: true; scopeKey: MemoryScopeKey; actor: MemoryActorContext }
  | { ok: false; error: string; code: string } => {
  if (!ctx.userId) {
    return {
      ok: false,
      error:
        "memory tool requires an authenticated user — current runtime context has no userId. Tell the user the memory tool is unavailable in this session and continue without memory operations.",
      code: "MEMORY_REQUIRES_USER",
    };
  }
  return {
    ok: true,
    scopeKey: {
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
    },
    actor: {
      userId: ctx.userId,
      actor: "agent",
      conversationId: ctx.conversationId,
    },
  };
};

export const createMemoryTool = () =>
  tool({
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: MemoryInputSchema,
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const built = buildContexts(ctx);
      if (!built.ok) {
        return { error: built.error, code: built.code };
      }
      const { scopeKey, actor } = built;

      const fieldsCheck = requireFieldsForCommand(input);
      if (!fieldsCheck.ok) {
        return { error: fieldsCheck.error, code: fieldsCheck.code };
      }

      try {
        switch (input.command) {
          case "view": {
            // Schema is `z.array(...).length(2)` (see view_range note),
            // so the runtime shape is guaranteed to be `[start, end]`
            // — narrow back to the tuple type the service expects.
            const viewRange =
              input.view_range && input.view_range.length === 2
                ? ([input.view_range[0], input.view_range[1]] as [
                    number,
                    number,
                  ])
                : undefined;
            const result = await viewMemory({
              rawPath: input.path!,
              viewRange,
              scopeKey,
            });
            return { ok: true, kind: result.kind, content: result.rendered };
          }
          case "create": {
            const created = await createMemory({
              rawPath: input.path!,
              content: input.file_text!,
              scopeKey,
              actor,
            });
            return {
              ok: true,
              message: `File created successfully at: ${formatMemoryPath(
                parseMemoryPath(input.path!),
              )}`,
              memoryId: created.id,
              sizeBytes: created.sizeBytes,
            };
          }
          case "overwrite": {
            const result = await overwriteMemory({
              rawPath: input.path!,
              content: input.file_text!,
              scopeKey,
              actor,
            });
            return {
              ok: true,
              message: result.created
                ? `File created successfully at: ${formatMemoryPath(
                    parseMemoryPath(input.path!),
                  )}`
                : "The memory file has been edited.",
              created: result.created,
              memoryId: result.memory.id,
              sizeBytes: result.memory.sizeBytes,
            };
          }
          case "delete": {
            await deleteMemory({
              rawPath: input.path!,
              scopeKey,
              actor,
              // No reason for agent-driven deletes — only the UI
              // surfaces that prompt to a human.
            });
            return {
              ok: true,
              message: `Successfully deleted ${formatMemoryPath(
                parseMemoryPath(input.path!),
              )}`,
            };
          }
          case "rename": {
            const updated = await renameMemory({
              oldRawPath: input.old_path!,
              newRawPath: input.new_path!,
              scopeKey,
              actor,
            });
            return {
              ok: true,
              message: `Successfully renamed ${formatMemoryPath(
                parseMemoryPath(input.old_path!),
              )} to ${formatMemoryPath(parseMemoryPath(input.new_path!))}`,
              memoryId: updated.id,
            };
          }
        }
      } catch (err) {
        return liftError(err);
      }
    },
  });
