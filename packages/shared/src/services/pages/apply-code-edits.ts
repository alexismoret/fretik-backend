import { runTextEdits, type TextEditFailure } from "../../lib/text-edits";
import {
  PAGE_ENTRY_FILE,
  PAGE_LIMITS,
  type PageCodeEdit,
} from "../../schemas/pages";

/**
 * Apply targeted edits to a page's SFC source.
 *
 * The mechanism — exact string anchors, refuse on ambiguity, near-miss context
 * on a failed anchor — lives in `lib/text-edits`, shared with document
 * authoring. This file supplies what is specific to a page: its size ceiling
 * and the way its agent gets a fresh copy.
 *
 * PARTIAL, unlike the document surface. A page update carries many anchors —
 * 37 changed sites per update, measured over 33 real ones (2026-08-23) — and
 * refusing all of them because one drifted costs a full re-emission of a write
 * the agent had already got right. The compiler is what makes keeping the rest
 * safe: a half-applied change that does not compile is refused downstream by
 * the write path, so the only states that reach storage are ones that build.
 */
export const applyPageCodeEdits = (
  source: string,
  edits: PageCodeEdit[],
):
  | { ok: true; source: string; failures: TextEditFailure[] }
  | { ok: false; error: string } => {
  const outcome = runTextEdits(source, edits, {
    maxChars: PAGE_LIMITS.maxSourceChars,
    subject: "source",
    reanchorHint: 'Call { action: "get" } and re-anchor.',
  });
  if (outcome.fatal) return { ok: false, error: outcome.fatal };
  // Every anchor missed: there is no partial result to keep, and the agent is
  // working from a stale view of the whole file rather than one drifted line.
  if (outcome.applied === 0) {
    const first = outcome.failures[0];
    return {
      ok: false,
      error: first?.error ?? "no edits were applied.",
    };
  }
  return { ok: true, source: outcome.text, failures: outcome.failures };
};

/**
 * The same, across a project: each edit patches the file it names, and an edit
 * that names none patches the entry.
 *
 * Grouped by file rather than applied in sequence over a concatenation,
 * because an anchor's uniqueness is a property of ONE file: the same
 * `class="p-4"` occurs in six components and in none of them ambiguously.
 */
export const applyPageProjectEdits = (
  code: { source: string; files?: Record<string, string> | undefined },
  edits: PageCodeEdit[],
):
  | {
      ok: true;
      code: { source: string; files?: Record<string, string> };
      failures: TextEditFailure[];
    }
  | { ok: false; error: string } => {
  const files = { ...(code.files ?? {}) };
  const known = new Set([PAGE_ENTRY_FILE, ...Object.keys(files)]);

  const grouped = new Map<string, { edit: PageCodeEdit; index: number }[]>();
  for (const [index, edit] of edits.entries()) {
    const path = edit.file ?? PAGE_ENTRY_FILE;
    if (!known.has(path)) {
      return {
        ok: false,
        error: `edit ${(index + 1).toString()}/${edits.length.toString()} names "${path}", which this page does not have. Its files are: ${[...known].join(", ")}.`,
      };
    }
    grouped.set(path, [...(grouped.get(path) ?? []), { edit, index }]);
  }

  let source = code.source;
  let applied = 0;
  const failures: TextEditFailure[] = [];
  for (const [path, group] of grouped) {
    const isEntry = path === PAGE_ENTRY_FILE;
    const before = isEntry ? source : (files[path] ?? "");
    const outcome = runTextEdits(
      before,
      group.map((entry) => entry.edit),
      {
        maxChars: isEntry
          ? PAGE_LIMITS.maxSourceChars
          : PAGE_LIMITS.maxFileChars,
        subject: isEntry ? "source" : path,
        reanchorHint: `Read ${path} again and re-anchor.`,
      },
    );
    if (outcome.fatal) return { ok: false, error: outcome.fatal };
    // The failure indexes are the GROUP's; the agent numbered its edits across
    // the whole call, so they are mapped back before anyone reads them.
    for (const failure of outcome.failures) {
      const original = group[failure.index - 1]?.index ?? failure.index - 1;
      failures.push({
        index: original + 1,
        error: `${path}: ${failure.error}`,
      });
    }
    applied += outcome.applied;
    if (isEntry) source = outcome.text;
    else files[path] = outcome.text;
  }

  if (applied === 0) {
    return {
      ok: false,
      error:
        failures[0]?.error ??
        "no edits were applied — nothing to change was found.",
    };
  }
  return {
    ok: true,
    code: {
      source,
      ...(Object.keys(files).length > 0 ? { files } : {}),
    },
    failures: failures.sort((a, b) => a.index - b.index),
  };
};
