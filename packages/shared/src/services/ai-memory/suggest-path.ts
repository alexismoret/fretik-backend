import type { AiMemoryScope } from "../../db/schema/ai-memory";
import { findMemoryByPath } from "./lookup";
import type { MemoryScopeKey } from "./types";

/**
 * Open-weight model used to suggest a semantic path from raw content.
 * Cheap + fast (sub-second on OpenRouter) so the user does not have
 * to wait noticeably when they hit "Save" in the settings UI.
 *
 * Override via `OPENROUTER_MEMORY_SUGGEST_MODEL` if you want to A/B
 * a different small model without redeploying.
 */
const MODEL_ID =
  process.env.OPENROUTER_MEMORY_SUGGEST_MODEL ?? "openai/gpt-oss-20b";

/**
 * Hard timeout for the LLM call. Anything longer is a UX-killer when
 * the user is just trying to save a note. We fall back to a slug
 * derived from the content on timeout / network error.
 */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Server-side cap on how much content we forward to the model. Most
 * memory notes are <1KB; the slice keeps prompt cost bounded if a
 * power user pastes a large block.
 */
const CONTENT_PREVIEW_CHARS = 1_500;

/**
 * Maximum total length of the suggested relative path. Beyond this
 * we slice — `MEMORY_INVALID_PATH` would otherwise reject the row.
 */
const MAX_PATH_LENGTH = 100;

/**
 * Path segments we explicitly forbid the model from suggesting,
 * because they would either collide with a structural folder or
 * confuse the agent's mental model. Validation in `paths.ts` catches
 * traversal attempts; this list keeps the SUGGESTIONS clean.
 */
const FORBIDDEN_SEGMENT = /^(\.|\.\.|memories|user|team)$/i;

interface OpenRouterChoice {
  message?: { content?: string | null };
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
}

/**
 * Slug helper — lower-cases, strips accents, replaces non-alnum runs
 * with `-`, trims dashes. Used for both the LLM prompt's example and
 * the deterministic fallback.
 */
const slugify = (raw: string): string =>
  raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/**
 * Best-effort recovery when the LLM is unreachable, slow, or returns
 * something we can't parse:
 *
 *  1. If the content has a top-level `# Heading`, slugify it →
 *     `<slug>.md`.
 *  2. Otherwise take the first non-empty line, slugify, append `.md`.
 *  3. Final guard rail: a timestamped note name so we never hand back
 *     an empty string.
 */
const fallbackPath = (content: string): string => {
  const heading = content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (heading) {
    const slug = slugify(heading);
    if (slug) return `${slug}.md`;
  }
  const firstLine = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) {
    const slug = slugify(firstLine);
    if (slug) return `${slug}.md`;
  }
  return `note-${Date.now().toString()}.md`;
};

/**
 * Sanitise whatever the model returned: strip leading slashes / known
 * prefixes (`/memories/<scope>/`), collapse double slashes, reject
 * obvious traversal sequences, force the `.md` suffix when missing.
 *
 * The downstream `parseMemoryPath()` runs full validation when the
 * path eventually flows through the create endpoint — this function
 * just makes "best effort" cleanups so the LLM output reaches that
 * stage in a parseable shape.
 */
const sanitisePath = (raw: string): string | null => {
  const trimmed = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\/+/, "")
    .replace(/^memories\/(user|team)\//i, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, MAX_PATH_LENGTH);
  if (!trimmed) return null;
  if (trimmed.includes("..")) return null;
  for (const segment of trimmed.split("/")) {
    if (!segment || FORBIDDEN_SEGMENT.test(segment)) return null;
  }
  // Prefer markdown extension if the model omitted it.
  return /\.[a-z0-9]{1,5}$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
};

/**
 * Resolve a unique relative path inside the namespace by appending
 * `-2`, `-3`, … until `findMemoryByPath` says it's free.
 *
 * Bounded at 50 attempts — beyond that the LLM keeps suggesting
 * effectively the same thing and we should give up rather than spin
 * the DB. Signals the caller that uniqueness could not be resolved.
 */
const ensureUnique = async (args: {
  scope: AiMemoryScope;
  scopeKey: MemoryScopeKey;
  proposed: string;
}): Promise<string> => {
  const { proposed, scope, scopeKey } = args;
  const dotIdx = proposed.lastIndexOf(".");
  const stem = dotIdx > 0 ? proposed.slice(0, dotIdx) : proposed;
  const ext = dotIdx > 0 ? proposed.slice(dotIdx) : "";

  for (let i = 0; i < 50; i++) {
    const candidate =
      i === 0 ? proposed : `${stem}-${(i + 1).toString()}${ext}`;
    const existing = await findMemoryByPath({
      scope,
      relativePath: candidate,
      scopeKey,
    });
    if (!existing) return candidate;
  }
  // Pathological case — fall back to a timestamp suffix.
  return `${stem}-${Date.now().toString()}${ext}`;
};

/**
 * Call OpenRouter's chat-completions endpoint with a tight system
 * prompt that asks for a single path and nothing else. Returns the
 * raw response text, or `null` on timeout / non-2xx / missing key.
 */
const callOpenRouter = async (args: {
  scope: AiMemoryScope;
  content: string;
  existingPaths: string[];
}): Promise<string | null> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  // Show only a sample of existing paths to anchor the model on the
  // team's naming conventions. 30 is enough to capture the dominant
  // folder structure without bloating the prompt.
  const sample = args.existingPaths.slice(0, 30).join("\n  ") || "(none)";

  const systemPrompt =
    args.scope === "team"
      ? "You are organising a TEAM-shared memory tree under /memories/team/. Suggest a SHORT relative path for a new note. Prefer existing folder conventions when relevant (e.g. vendors/<slug>.md, clients/<slug>.md, processes/<slug>.md, conventions.md). Use kebab-case slugs. Output ONLY the path (no leading slash, no /memories/team/ prefix), nothing else."
      : "You are organising a PRIVATE user memory tree under /memories/user/. Suggest a SHORT relative path for a new personal note (preferences, shortcuts, reminders). Use kebab-case slugs. Output ONLY the path (no leading slash, no /memories/user/ prefix), nothing else.";

  const userPrompt = [
    "Existing paths in this namespace (for inspiration):",
    `  ${sample}`,
    "",
    "New note content:",
    "---",
    args.content.slice(0, CONTENT_PREVIEW_CHARS),
    "---",
    "",
    "Path:",
  ].join("\n");

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(
        `[memory:suggest-path] OpenRouter ${res.status.toString()} ${res.statusText}`,
      );
      return null;
    }
    const json = (await res.json()) as OpenRouterResponse;
    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.warn(
      "[memory:suggest-path] OpenRouter call failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Suggest a relative path under the requested scope's namespace
 * for a new memory note.
 *
 * Strategy:
 *  1. Ask `OPENROUTER_MEMORY_SUGGEST_MODEL` (default: `openai/gpt-oss-20b`)
 *     to produce a path, anchored on a sample of existing paths so it
 *     re-uses the team's folder conventions.
 *  2. Sanitise the response (strip prefix/quotes, force `.md` suffix,
 *     refuse traversal segments).
 *  3. On any error / timeout / unparseable output, fall back to a slug
 *     derived from the content's first heading or first non-empty line.
 *  4. Resolve uniqueness against the DB by appending `-N` until the
 *     `(scope, userId, path)` partial unique index has room.
 *
 * Returned path is RELATIVE to `/memories/<scope>/` — the API handler
 * builds the full path before forwarding to `createMemory()`.
 */
export const suggestMemoryPath = async (args: {
  scope: AiMemoryScope;
  content: string;
  scopeKey: MemoryScopeKey;
  existingPaths: string[];
}): Promise<string> => {
  const llmRaw = await callOpenRouter({
    scope: args.scope,
    content: args.content,
    existingPaths: args.existingPaths,
  });

  const sanitised = llmRaw ? sanitisePath(llmRaw) : null;
  const proposed = sanitised ?? fallbackPath(args.content);

  return await ensureUnique({
    scope: args.scope,
    scopeKey: args.scopeKey,
    proposed,
  });
};
