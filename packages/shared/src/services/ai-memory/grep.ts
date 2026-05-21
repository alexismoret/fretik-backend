import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import db from "../../db";
import { aiMemories, type AiMemoryScope } from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import type { MemoryScopeKey } from "./types";

/**
 * Pattern length floor. Anything shorter is overwhelmingly likely
 * to be either accidental or so generic the response would dominate
 * the model's context window.
 */
const PATTERN_MIN_LENGTH = 3;

/**
 * Stopwords filtered case-insensitively after trim. The check runs
 * against the whole pattern AND each whitespace-separated token —
 * "and the" is rejected even though neither word matches the cap by
 * itself, because the substring is too generic.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "are",
  "was",
  "were",
  "for",
  "but",
  "with",
  "from",
  "this",
  "that",
  "been",
  "have",
  "has",
  "had",
  "his",
  "her",
  "you",
  "your",
  "our",
  "les",
  "des",
  "une",
  "ces",
  "ils",
  "elle",
  "nous",
  "vous",
  "qui",
  "que",
  "pas",
  "est",
  "son",
  "sur",
  "par",
  "pour",
  "avec",
  "dans",
  "ton",
  "ses",
  "leurs",
]);

/**
 * Per-line truncation cap. A grep hit on a 50KB single-line file
 * would otherwise return the whole line. We center the window
 * around the match instead of taking the leading bytes — see
 * `clipLineAroundMatch` below — so the model always sees the
 * matching context, not arbitrary prefix.
 */
const LINE_CONTEXT_AROUND = 80;
const LINE_HARD_CAP = LINE_CONTEXT_AROUND * 2 + 60;

/**
 * Total payload soft cap. Each result row is ~150 chars + clipped
 * line; this guards against an attacker-controlled `max_results`
 * combined with a huge dictionary word.
 */
const TOTAL_PAYLOAD_BYTES = 30_000;

const ABSOLUTE_MAX_RESULTS = 50;

/**
 * Hard upper bound on the number of memory rows we materialise from
 * SQL into Node memory. Each row carries `content` (up to ~50KB),
 * so 500 rows = ~25MB worst-case payload to JS — enough headroom
 * for any real query, low enough to bound process memory if the
 * pattern is too common.
 *
 * `rowLimitHit` is surfaced in the result so the model can decide
 * to refine the pattern when this fires.
 */
const HARD_ROW_LIMIT = 500;

/**
 * Coupling marker — the SQL pre-filter is `ILIKE` (case-insensitive),
 * which is why the JS line refinement also lower-cases both sides.
 * If anyone later changes the SQL to `LIKE` "for performance", they
 * MUST update this constant and the JS branch in lockstep — otherwise
 * the JS would silently drop hits that ILIKE found.
 */
const CASE_SENSITIVE = false;

interface GrepHit {
  scope: AiMemoryScope;
  path: string;
  /**
   * Snake_case (not camelCase) — kept this way because the field
   * names match Anthropic's reference shape, so the model has seen
   * this convention during pre-training. Do not rename to
   * `lineNumber` "for consistency" without checking model behaviour.
   */
  line_number: number;
  line_content: string;
  truncated: boolean;
}

type TruncationReason = "none" | "max_results" | "payload";

/**
 * Escape ILIKE wildcards (`%`, `_`) and the escape character itself
 * (`\\`) so the pattern can be embedded as a literal substring.
 */
const escapeIlike = (raw: string): string =>
  raw.replace(/[\\%_]/g, (match) => `\\${match}`);

/**
 * Convert a path glob to an ILIKE pattern.
 *
 *  - `*` → `%`
 *  - `?` → `_`
 *  - `%` / `_` / `\\` → escaped (so users can't smuggle wildcards)
 *
 * Convenience rule: a glob without any wildcard AND without a dot
 * (e.g. `vendors`) is treated as a folder prefix and gets an
 * implicit `*` suffix (`vendors/*`-equivalent). The model writing
 * `pathGlob: "vendors"` almost certainly wants the folder, not an
 * exact-match file with no extension. Folder names with a dot
 * (`v1.0`) are kept strict — the dot signals an explicit file.
 */
const escapePathGlob = (glob: string): string => {
  const hasWildcard = /[*?]/.test(glob);
  const looksLikeFile = glob.includes(".");
  const effective = hasWildcard || looksLikeFile ? glob : `${glob}/*`;

  let out = "";
  for (const ch of effective) {
    if (ch === "*") {
      out += "%";
    } else if (ch === "?") {
      out += "_";
    } else if (ch === "%" || ch === "_" || ch === "\\") {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
};

/**
 * Slice a line down to a window centred on the first match of
 * `pattern`. Adds Unicode ellipses on either side when content is
 * trimmed. Lines shorter than `LINE_HARD_CAP` are returned as-is.
 */
const clipLineAroundMatch = (
  line: string,
  lowerPattern: string,
): { content: string; truncated: boolean } => {
  if (line.length <= LINE_HARD_CAP) {
    return { content: line, truncated: false };
  }
  const matchIdx = line.toLowerCase().indexOf(lowerPattern);
  if (matchIdx < 0) {
    // Should not happen — caller already checked includes — but be
    // defensive: fall back to leading prefix.
    return {
      content: `${line.slice(0, LINE_HARD_CAP)}…`,
      truncated: true,
    };
  }
  const start = Math.max(0, matchIdx - LINE_CONTEXT_AROUND);
  const end = Math.min(
    line.length,
    matchIdx + lowerPattern.length + LINE_CONTEXT_AROUND,
  );
  const head = start > 0 ? "…" : "";
  const tail = end < line.length ? "…" : "";
  return {
    content: `${head}${line.slice(start, end)}${tail}`,
    truncated: head !== "" || tail !== "",
  };
};

/**
 * Search memory contents for a literal substring. The trigram GIN
 * index on `ai_memories.content` (`pg_trgm`) accelerates the
 * `ILIKE '%pattern%'` filter — for large memory sets this is the
 * difference between a full table scan and a low-millisecond hit.
 *
 * The agent's first-line strategy when looking up a known fact in
 * a busy memory ("DHL contact?", "transit time Marseille?"). Every
 * write/read should encourage `grep` over `view <whole file>`.
 */
export const grepMemory = async (args: {
  pattern: string;
  scope?: AiMemoryScope | "all";
  pathGlob?: string;
  maxResults?: number;
  scopeKey: MemoryScopeKey;
}): Promise<{
  hits: GrepHit[];
  totalRowsScanned: number;
  rowLimitHit: boolean;
  truncationReason: TruncationReason;
}> => {
  const trimmed = args.pattern.trim();
  if (trimmed.length < PATTERN_MIN_LENGTH) {
    return throwHttpError(
      400,
      createApiError(
        "MEMORY_PATTERN_TOO_GENERIC",
        `Pattern must be at least ${PATTERN_MIN_LENGTH.toString()} characters long after trimming.`,
      ),
    );
  }
  const lowerWhole = trimmed.toLowerCase();
  if (STOPWORDS.has(lowerWhole)) {
    return throwHttpError(
      400,
      createApiError(
        "MEMORY_PATTERN_TOO_GENERIC",
        `Pattern "${trimmed}" is a common stopword; use a more specific term.`,
      ),
    );
  }
  const tokens = lowerWhole.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length > 0 && tokens.every((t) => STOPWORDS.has(t))) {
    return throwHttpError(
      400,
      createApiError(
        "MEMORY_PATTERN_TOO_GENERIC",
        `Pattern "${trimmed}" only contains stopwords; use a more specific term.`,
      ),
    );
  }

  const cap = Math.min(args.maxResults ?? 20, ABSOLUTE_MAX_RESULTS);
  const scope = args.scope ?? "all";

  const escapedPattern = escapeIlike(trimmed);
  const ilikeArg = `%${escapedPattern}%`;

  // Drizzle's `ilike()` does not expose ESCAPE, so emit raw SQL.
  // Default ESCAPE in PG is backslash — we set it explicitly for
  // safety against future configuration drift.
  const ilikePredicate = sql`${aiMemories.content} ILIKE ${ilikeArg} ESCAPE '\\'`;

  const scopeFilter =
    scope === "all"
      ? or(
          and(
            eq(aiMemories.scope, "user"),
            eq(aiMemories.userId, args.scopeKey.userId),
          ),
          and(eq(aiMemories.scope, "team"), isNull(aiMemories.userId)),
        )
      : scope === "user"
        ? and(
            eq(aiMemories.scope, "user"),
            eq(aiMemories.userId, args.scopeKey.userId),
          )
        : and(eq(aiMemories.scope, "team"), isNull(aiMemories.userId));

  const pathFilter =
    args.pathGlob && args.pathGlob !== ""
      ? like(aiMemories.path, escapePathGlob(args.pathGlob))
      : undefined;

  const whereClause = and(
    eq(aiMemories.organizationId, args.scopeKey.organizationId),
    eq(aiMemories.teamId, args.scopeKey.teamId),
    scopeFilter,
    pathFilter,
    ilikePredicate,
  );

  const rows = await db
    .select({
      scope: aiMemories.scope,
      path: aiMemories.path,
      content: aiMemories.content,
    })
    .from(aiMemories)
    .where(whereClause)
    .limit(HARD_ROW_LIMIT);

  const rowLimitHit = rows.length === HARD_ROW_LIMIT;

  // Lower-case both sides — must stay in sync with the SQL ILIKE.
  // See `CASE_SENSITIVE` constant above.
  const compareNeedle = CASE_SENSITIVE ? trimmed : lowerWhole;
  const transformLine = CASE_SENSITIVE
    ? (l: string): string => l
    : (l: string): string => l.toLowerCase();

  const hits: GrepHit[] = [];
  let payloadBytes = 0;
  let truncationReason: TruncationReason = "none";

  outer: for (const row of rows) {
    const lines = row.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!transformLine(line).includes(compareNeedle)) continue;

      const clipped = clipLineAroundMatch(line, lowerWhole);

      const hit: GrepHit = {
        scope: row.scope,
        path: row.path,
        line_number: i + 1,
        line_content: clipped.content,
        truncated: clipped.truncated,
      };

      const hitBytes = Buffer.byteLength(JSON.stringify(hit), "utf8");
      if (payloadBytes + hitBytes > TOTAL_PAYLOAD_BYTES) {
        truncationReason = "payload";
        break outer;
      }
      hits.push(hit);
      payloadBytes += hitBytes;
      if (hits.length >= cap) {
        truncationReason = "max_results";
        break outer;
      }
    }
  }

  return {
    hits,
    totalRowsScanned: rows.length,
    rowLimitHit,
    truncationReason,
  };
};
