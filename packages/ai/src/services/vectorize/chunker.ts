/**
 * Markdown-aware recursive chunker.
 *
 * Target size is locked to 512 tokens / ~2000 chars per chunk with a
 * ~100 token / ~400 char overlap between consecutive chunks — Vecta 2026
 * + NAACL 2025 benchmark winners for mixed-content RAG (see
 * `chatbot-overhaul-progress.json.keyDecisions.phase7ChunkSize`).
 *
 * Two-pass strategy (LangChain-style MarkdownHeader + RecursiveCharacter):
 *
 *   1. Header split — scan the document top-down, open a new "section"
 *      every time an ATX header (`#`..`######`) appears. Each section
 *      inherits the full heading trail of its ancestors (e.g. a level-3
 *      header nested under a level-1 title carries `# Title > ## Sub >
 *      ### Part` as its `headingPath`). Fenced code blocks (``` / ~~~)
 *      are tracked so a `#` INSIDE a code block is treated as plain text.
 *
 *   2. Recursive character split — inside each section, split the body
 *      on progressively finer separators until every piece fits the
 *      target size: `\n\n` (paragraphs) → `\n` (lines) → ` ` (words) →
 *      hard character cut as the last resort. Code fences are never
 *      broken: a fenced block is treated atomically during paragraph
 *      and line splits.
 *
 * The heading trail is re-prepended to every emitted chunk so the
 * semantic context of each fragment is preserved even after the section
 * body is sliced. Short documents (Excel summaries, workflow summaries,
 * extraction summaries) that fit inside a single target span naturally
 * become one chunk.
 */

/** Target chunk size, in characters (~512 tokens at the Anthropic chars/4 heuristic). */
export const CHUNK_TARGET_CHARS = 2_000;

/** Hard ceiling per chunk, in characters — ~25% headroom above target. */
export const CHUNK_MAX_CHARS = 2_500;

/** Overlap between consecutive chunks when a section is recursively split. */
export const CHUNK_OVERLAP_CHARS = 400;

/** Minimum remaining content size that is worth emitting as its own chunk. */
const CHUNK_MIN_TAIL_CHARS = 120;

export interface Chunk {
  /** 0-based chunk index across the whole document. */
  index: number;
  /** Total number of chunks produced for the document (backfilled after the fact). */
  totalChunks: number;
  /**
   * Chunk text ready for contextual enrichment and embedding. Includes the
   * heading trail (if any) followed by a blank line and the chunk body.
   */
  content: string;
}

interface HeaderSection {
  headingPath: string;
  body: string;
}

const FENCE_RE = /^(```|~~~)/;
const ATX_HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Pass 1 — split on ATX headers. Preserves the ancestor heading trail on
 * each section so downstream chunks can be re-tagged with context.
 */
const splitByHeaders = (markdown: string): HeaderSection[] => {
  const lines = markdown.split("\n");
  const sections: HeaderSection[] = [];

  const headingStack: { level: number; text: string }[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const currentHeadingPath = (): string =>
    headingStack.map((h) => "#".repeat(h.level) + " " + h.text).join("\n");

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body.length > 0) {
      sections.push({ headingPath: currentHeadingPath(), body });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }

    if (!inFence) {
      const m = line.match(ATX_HEADER_RE);
      if (m) {
        flush();
        const level = m[1]!.length;
        const text = m[2]!;
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1]!.level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text });
        continue;
      }
    }

    buffer.push(line);
  }
  flush();

  if (sections.length === 0 && markdown.trim().length > 0) {
    sections.push({ headingPath: "", body: markdown.trim() });
  }

  return sections;
};

/**
 * Splits body text on a separator while keeping fenced code blocks intact.
 * When a candidate split point falls inside an open code fence the splitter
 * advances to the next candidate. Returns the list of resulting parts — any
 * empty trailing/leading whitespace is preserved so overlap logic stays
 * deterministic.
 */
const splitKeepingFences = (text: string, separator: string): string[] => {
  if (separator === "") {
    return [text];
  }

  const parts: string[] = [];
  let inFence = false;
  let cursor = 0;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i) || text.startsWith("~~~", i)) {
      const atLineStart = i === 0 || text[i - 1] === "\n";
      if (atLineStart) {
        inFence = !inFence;
      }
      i += 3;
      continue;
    }
    if (!inFence && text.startsWith(separator, i)) {
      parts.push(text.slice(cursor, i));
      cursor = i + separator.length;
      i = cursor;
      continue;
    }
    i++;
  }
  parts.push(text.slice(cursor));
  return parts;
};

/**
 * Pass 2 — recursive character split. Uses a separator hierarchy to keep
 * splits at the most semantically meaningful boundary that still fits the
 * target size. A final hard-character fallback guarantees termination on
 * any pathological input (e.g. a 5KB single line).
 */
const recursiveSplit = (body: string): string[] => {
  if (body.length <= CHUNK_MAX_CHARS) {
    return [body];
  }

  const separators = ["\n\n", "\n", " ", ""];

  for (const sep of separators) {
    const parts = splitKeepingFences(body, sep);
    // No progress possible with this separator (the body has no
    // occurrence of it, including the empty-string sentinel which
    // `splitKeepingFences` short-circuits to `[text]`). Try the next
    // finer separator; once we exhaust them all, the for-loop exits
    // and the hard-character fallback below takes over. Without this
    // guard, the empty-string branch would re-enter the merge block
    // with `parts = [body]` and call `recursiveSplit(part)` on the
    // same body — an infinite recursion that blows the stack on any
    // monolithic blob (regression caught on `skills/pdf/SKILL.md`).
    if (parts.length === 1) {
      continue;
    }

    const merged: string[] = [];
    let current = "";

    const push = () => {
      const trimmed = current.trim();
      if (trimmed.length > 0) merged.push(trimmed);
      current = "";
    };

    for (const part of parts) {
      const candidate = current.length === 0 ? part : current + sep + part;
      if (candidate.length <= CHUNK_TARGET_CHARS) {
        current = candidate;
        continue;
      }
      if (current.length > 0) {
        push();
      }
      if (part.length <= CHUNK_MAX_CHARS) {
        current = part;
      } else {
        // Single part still too large — recurse with a finer separator.
        const subParts = recursiveSplit(part);
        for (const sp of subParts) {
          merged.push(sp.trim());
        }
        current = "";
      }
    }
    push();

    if (merged.every((m) => m.length <= CHUNK_MAX_CHARS)) {
      return applyOverlap(merged);
    }
  }

  // Fallback — hard character cut with overlap.
  const out: string[] = [];
  let start = 0;
  while (start < body.length) {
    const end = Math.min(start + CHUNK_TARGET_CHARS, body.length);
    out.push(body.slice(start, end).trim());
    if (end === body.length) break;
    start = end - CHUNK_OVERLAP_CHARS;
    if (start <= 0) start = end;
  }
  return out;
};

/**
 * Apply a trailing overlap between consecutive chunks. Copies the last
 * ~CHUNK_OVERLAP_CHARS of chunk `i` onto the head of chunk `i+1`. Keeps
 * retrieval robust when a relevant fact straddles a split boundary.
 */
const applyOverlap = (chunks: string[]): string[] => {
  if (chunks.length <= 1) return chunks;

  const out: string[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const tail = prev.slice(Math.max(0, prev.length - CHUNK_OVERLAP_CHARS));
    const current = chunks[i]!;
    const merged = tail + "\n" + current;
    out.push(merged.length <= CHUNK_MAX_CHARS ? merged : current);
  }
  return out;
};

/**
 * Public entrypoint. Runs the two passes and returns one `Chunk` per
 * resulting fragment, with `totalChunks` backfilled.
 */
export const splitMarkdown = (markdown: string): Chunk[] => {
  if (markdown.trim().length === 0) {
    return [];
  }

  const sections = splitByHeaders(markdown);
  const pieces: string[] = [];

  for (const section of sections) {
    const parts = recursiveSplit(section.body);
    for (const part of parts) {
      if (part.trim().length < CHUNK_MIN_TAIL_CHARS && pieces.length > 0) {
        // Stitch tiny trailing fragments back onto the previous piece so
        // we do not emit a chunk that is mostly a heading.
        const previous = pieces.pop()!;
        const combined = previous + "\n\n" + part;
        if (combined.length <= CHUNK_MAX_CHARS) {
          pieces.push(combined);
          continue;
        }
        pieces.push(previous);
      }
      const prefix =
        section.headingPath.length > 0
          ? section.headingPath + "\n\n" + part
          : part;
      pieces.push(prefix);
    }
  }

  const totalChunks = pieces.length;
  return pieces.map((content, index) => ({
    index,
    totalChunks,
    content,
  }));
};
