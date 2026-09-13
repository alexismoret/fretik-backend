import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import {
  CHAT_SUGGESTION_PRIORITY,
  MAX_CHAT_SUGGESTIONS,
  MAX_LABEL_CHARS,
  MAX_PER_KIND,
  MAX_REASON_CHARS,
  suggestionDraftSchema,
  type SuggestionDraft,
} from "@fretik/shared/schemas/chat-suggestions";
import { z } from "zod";

/**
 * Turn the model's answer into the batch that gets stored, dropping anything
 * that cannot be trusted or shown.
 *
 * Defensive by construction, like every other structured aux call here: the
 * schema reaches the model through the PROMPT (`Output.object` is not used —
 * see `lib/schema-prompt.ts`), so the answer is free-form text that usually
 * parses and sometimes does not. A failure costs the batch, never the request.
 *
 * The `sourceIds` gate is the one rule worth stating twice. A suggestion
 * citing an id the pack never offered is the exact shape of an invented fact —
 * a client that does not exist, a run that never failed — so it is dropped
 * rather than shown, whatever it says. `capability` is the single exception:
 * "you have a workflow for this" is a statement about the product, and the
 * capability lines are in the pack for the model to notice rather than cite.
 */
const KIND_RANK = new Map(
  CHAT_SUGGESTION_PRIORITY.map((kind, index) => [kind, index]),
);

/**
 * Item by item, not batch at once. One suggestion with a 70-character label is
 * one card lost; validating the array as a whole would make it six, and the
 * screen would fall back to generic starters because of a typo in the fifth
 * entry. The envelope stays permissive for the same reason — a model that
 * offers nine good ideas should have six of them shown, not none.
 */
const envelopeSchema = z.object({ suggestions: z.array(z.unknown()) });

/**
 * Clip on a word boundary rather than refuse. Measured against the real model
 * on 2026-09-13: five of five drafts carried a `reason` over the 120-character
 * length the prompt asks for, and rejecting on length emptied the whole batch —
 * a screen lost to a style rule. The prompt still asks for short; the storage
 * limit is what is enforced.
 */
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

export const parseSuggestions = (
  raw: string,
  allowedSourceIds: ReadonlySet<string>,
): SuggestionDraft[] => {
  const envelope = envelopeSchema.safeParse(parseLlmJsonObject(raw));
  if (!envelope.success) {
    console.warn(
      "[chat-suggestions] unparseable output, keeping the previous batch:",
      envelope.error.issues[0]?.message,
    );
    return [];
  }

  const seenLabels = new Set<string>();
  const perKind = new Map<string, number>();
  const kept: SuggestionDraft[] = [];
  // An empty batch and a batch the model never wrote look identical from the
  // outside, and one is a prompt problem while the other is an outage. Counted
  // by reason so the difference is visible in the logs and in the probe.
  const dropped = new Map<string, number>();
  const drop = (reason: string): void => {
    dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
  };

  const drafts = envelope.data.suggestions.flatMap((entry) => {
    const parsed = suggestionDraftSchema.safeParse(entry);
    if (parsed.success) return [parsed.data];
    const issue = parsed.error.issues[0];
    drop(`schema:${issue?.path.join(".") ?? "?"}:${issue?.code ?? "?"}`);
    return [];
  });

  const ordered = [...drafts].sort(
    (a, b) =>
      (KIND_RANK.get(a.kind) ?? Number.MAX_SAFE_INTEGER) -
      (KIND_RANK.get(b.kind) ?? Number.MAX_SAFE_INTEGER),
  );

  for (const draft of ordered) {
    const cited = draft.sourceIds.filter((id) => id.length > 0);
    const unknown = cited.filter((id) => !allowedSourceIds.has(id));
    if (unknown.length > 0) {
      drop(`unknown-source-id (${unknown[0] ?? ""})`);
      continue;
    }
    if (cited.length === 0 && draft.kind !== "capability") {
      drop("no-source-id");
      continue;
    }

    const label = clip(draft.label, MAX_LABEL_CHARS);
    const prompt = draft.prompt.trim();
    if (label.length === 0 || prompt.length === 0) {
      drop("empty-label-or-prompt");
      continue;
    }

    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      drop("duplicate-label");
      continue;
    }

    const used = perKind.get(draft.kind) ?? 0;
    if (used >= MAX_PER_KIND) {
      drop(`over-cap:${draft.kind}`);
      continue;
    }

    seenLabels.add(labelKey);
    perKind.set(draft.kind, used + 1);
    kept.push({
      ...draft,
      label,
      prompt,
      reason: clip(draft.reason, MAX_REASON_CHARS),
      sourceIds: cited,
    });

    if (kept.length >= MAX_CHAT_SUGGESTIONS) break;
  }

  if (dropped.size > 0) {
    console.warn(
      `[chat-suggestions] kept ${String(kept.length)} of ${String(envelope.data.suggestions.length)} — dropped: ${[
        ...dropped,
      ]
        .map(([reason, count]) => `${reason} x${String(count)}`)
        .join(", ")}`,
    );
  }

  return kept;
};
