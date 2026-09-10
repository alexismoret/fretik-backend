import type {
  DigestInputs,
  DigestScope,
} from "@fretik/shared/services/memory-digest/collect-inputs";
import { collectDigestInputs } from "@fretik/shared/services/memory-digest/collect-inputs";
import { readTeamDigest } from "@fretik/shared/services/memory-digest/read";
import {
  markTeamDigestStale,
  writeTeamDigest,
} from "@fretik/shared/services/memory-digest/write";
import { generateText } from "ai";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withNamedTrace } from "../../lib/trace-tool";
import { expandHandles, makeHandleAllocator } from "../recall/recall";

/**
 * Rewrites a team's digest — the summary injected into every turn without
 * retrieving anything.
 *
 * What makes this different from every other memory writer: a bad episode is
 * one candidate among fifty that the selector may not even render, while a bad
 * digest is read by every member on every turn until the next successful run.
 * So the model's output is not trusted, it is GATED — every provenance marker
 * must resolve to a row this function actually read, and anything that does not
 * is dropped before the text is stored.
 */

/** Reasoning eats this budget too — see `memory-consolidate` for the measured trap. */
const DIGEST_MAX_OUTPUT_TOKENS = 12_000;
/** Nightly and debounced, so a slow model costs nothing a user can feel. */
const DIGEST_TIMEOUT_MS = 120_000;
const DIGEST_TEMPERATURE = 0;

/**
 * Hard ceiling on what reaches the prompt, measured with the tokeniser the
 * budget script uses rather than estimated.
 *
 * 1 200 is a PROMPT budget, not a quality target: this text is added to every
 * turn of every member, so it is paid on the whole conversation volume of the
 * product. A digest that needs more than this is summarising the corpus instead
 * of the team.
 */
const DIGEST_MAX_TOKENS = 1_200;

const countTokens = (text: string): number => encode(text).length;

const LOG_SOURCE = "[memory-digest] model";

/**
 * The instruction. Deliberately short: everything the model needs to be
 * accurate is in the inputs, and everything it needs to be safe is enforced
 * downstream by the marker gate rather than asked for here.
 */
const DIGEST_SYSTEM_PROMPT = `You write a team's standing memory: a short brief its assistant reads before every conversation.

The input below is the ONLY source of truth. NEVER state a fact, number, date or name that is not in it — an invented line is served to the whole team on every turn.

Each input block below maps to exactly one section. Output them in this order, writing each heading EXACTLY as it appears to the right. A block that is absent means its section is omitted entirely — never refill a section from another block.

<conventions>   ->  ## Conventions — how this team works
<entities>      ->  ## Key entities — who and what they work with
<decisions>     ->  ## Current decisions — most recent wins
<open_threads>  ->  ## Open threads — what is still moving

Rules:
- One line per item. End every line with the marker of EACH input it draws on, copied verbatim, e.g. \`(memory:M3)\` or \`(memory:M3) (memory:M7)\`.
- When several inputs say the same thing, write ONE line and carry all their markers. Four wordings of one rule cost the team four lines of a budget that holds a few dozen.
- Under Key entities, write ONE line per entity, naming it, in prose. The arrows in the input are notation to read, never to copy: \`predicate → X\` means the entity does that to X, \`predicate ← X\` means X does it to the entity. Stating one as the other inverts the fact.
- Under Current decisions, open each line with \`As of <date>\`. When two inputs disagree, state the most recent and add \`(previously …)\`.
- Write in the language of the inputs.
- Facts only. No advice, no opinions, no next steps, no preamble, no closing line.
- Under 1000 tokens.`;

const renderInputs = (
  inputs: DigestInputs,
): { prompt: string; handles: Map<string, string> } => {
  const { handleFor, handles } = makeHandleAllocator();
  const parts: string[] = [];

  if (inputs.conventions.length > 0) {
    parts.push(
      `<conventions>\n${inputs.conventions
        .map((c) => `(${handleFor("memory", c.path)}) ${c.path}\n${c.content}`)
        .join("\n\n")}\n</conventions>`,
    );
  }
  if (inputs.entities.length > 0) {
    parts.push(
      `<entities>\n${inputs.entities
        .map(
          (e) =>
            `(${handleFor("record", e.id)}) ${e.label} [${e.collectionKey}]${
              e.links.length > 0 ? `\n  ${e.links.join("\n  ")}` : ""
            }`,
        )
        .join("\n")}\n</entities>`,
    );
  }
  if (inputs.decisions.length > 0) {
    parts.push(
      `<decisions>\n${inputs.decisions
        .map(
          (d) =>
            `(${handleFor("episode", d.id)}) ${
              d.occurredTo
                ? `${d.occurredTo.toISOString().slice(0, 10)} — `
                : ""
            }${d.title}\n${d.summary}`,
        )
        .join("\n\n")}\n</decisions>`,
    );
  }
  if (inputs.threads.length > 0) {
    parts.push(
      `<open_threads>\n${inputs.threads
        .map((t) => `(${handleFor("episode", t.id)}) ${t.title}\n${t.summary}`)
        .join("\n\n")}\n</open_threads>`,
    );
  }

  return { prompt: parts.join("\n\n"), handles };
};

/**
 * Drop headings left with nothing under them.
 *
 * Three ways a section empties: the prompt asks for sections with no input to
 * be omitted and the model emits them anyway (observed: an empty "## Open
 * threads" on a team with none), the marker gate drops a section's only line,
 * or the budget trim cuts its lines from the end. A heading carrying no claim
 * spends prompt budget on every turn of every member to say nothing.
 */
const dropEmptySections = (lines: readonly string[]): string[] =>
  lines.filter((line, i) => {
    if (!line.trim().startsWith("#")) return true;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]?.trim() ?? "";
      if (next === "") continue;
      return !next.startsWith("#");
    }
    return false;
  });

/**
 * Drop every line whose marker the model invented, then trim to budget.
 *
 * Line-granular on purpose. `expandHandles` already blanks an unknown marker,
 * but a LINE that lost its marker is a claim with no provenance left — the one
 * shape the agent cannot check and the reader cannot trace. The prompt asks for
 * one marker per line precisely so this gate can work at that granularity.
 *
 * The trim is also line-granular, and that is not cosmetic: cutting mid-marker
 * hands the agent a truncated id it will spend a tool call on for nothing —
 * exactly the trap the verbatim block's size cap already documents.
 */
export const gateDigest = (
  raw: string,
  handles: Map<string, string>,
): { content: string; dropped: number } => {
  const MARKER = /\((memory|episode|record|document):[^)\s]+\)/;
  let dropped = 0;

  const kept = raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Headings, blanks and section markers carry no claim, so they need no
      // provenance; anything else that asserts something must have one.
      if (trimmed === "" || trimmed.startsWith("#")) return true;
      const expanded = expandHandles(trimmed, handles, LOG_SOURCE);
      if (MARKER.test(expanded)) return true;
      dropped += 1;
      return false;
    })
    .map((line) =>
      line.trim().startsWith("#")
        ? line
        : expandHandles(line, handles, LOG_SOURCE),
    );

  const lines = dropEmptySections(kept);

  // Trim to budget on a line boundary, from the end.
  while (
    lines.length > 0 &&
    countTokens(lines.join("\n")) > DIGEST_MAX_TOKENS
  ) {
    lines.pop();
  }

  // Run the section drop AGAIN: the trim pops from the end, so it strands the
  // heading of the section it just emptied. Measured on the first real digest —
  // a naked "## Open threads" survived because its lines were exactly what the
  // budget cut.
  return { content: dropEmptySections(lines).join("\n").trim(), dropped };
};

export interface BuildTeamDigestParams extends DigestScope {
  /** Rebuild even when the inputs are unchanged. Operator + eval door. */
  force?: boolean;
  /** EVAL ONLY — same contract as `judgeProfileKey` in recall. */
  modelProfileKey?: string;
}

export type BuildTeamDigestResult =
  | { status: "skipped"; reason: "unchanged" | "no-inputs" }
  | { status: "written"; tokenCount: number; dropped: number }
  | { status: "kept-previous"; reason: "empty" | "truncated" | "no-previous" };

export const buildTeamDigest = async (
  params: BuildTeamDigestParams,
): Promise<BuildTeamDigestResult> => {
  const { organizationId, teamId } = params;
  const inputs = await collectDigestInputs({ organizationId, teamId });

  const nothingToSay =
    inputs.conventions.length === 0 &&
    inputs.entities.length === 0 &&
    inputs.decisions.length === 0 &&
    inputs.threads.length === 0;
  if (nothingToSay) return { status: "skipped", reason: "no-inputs" };

  const existing = await readTeamDigest(teamId);
  // The whole point of hashing the inputs: a team that changed nothing costs
  // one hash and no tokens, however often the job fires.
  if (
    !params.force &&
    existing &&
    existing.sourceFingerprint === inputs.fingerprint
  ) {
    return { status: "skipped", reason: "unchanged" };
  }

  const { prompt, handles } = renderInputs(inputs);

  const generated = await withNamedTrace(
    "memory-digest",
    {
      sessionId: `memory-digest:${teamId}`,
      metadata: { teamId, fingerprint: inputs.fingerprint },
      tags: ["process:memory-digest", `team:${teamId}`],
    },
    async () => {
      const { model, profile } = await resolveMemoryModel(
        "memory-digest",
        teamId,
        params.modelProfileKey,
      );
      const { text, finishReason } = await generateText({
        model,
        instructions: DIGEST_SYSTEM_PROMPT,
        prompt,
        temperature: DIGEST_TEMPERATURE,
        maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(DIGEST_TIMEOUT_MS),
        telemetry: telemetryFor("memory-digest"),
      });
      return { text, finishReason, profileKey: profile.key };
    },
  );

  // A truncated digest is not a partial digest — the sections it lost are
  // invisible, and it would be served as complete on every turn.
  if (generated.finishReason === "length" || generated.text.trim() === "") {
    const reason = generated.finishReason === "length" ? "truncated" : "empty";
    console.warn(
      `[memory-digest] team ${teamId}: ${reason} output — keeping the previous digest`,
    );
    if (!existing) return { status: "kept-previous", reason: "no-previous" };
    await markTeamDigestStale(teamId);
    return { status: "kept-previous", reason };
  }

  const { content, dropped } = gateDigest(generated.text, handles);
  if (content === "") {
    console.warn(
      `[memory-digest] team ${teamId}: every line failed the marker gate — keeping the previous digest`,
    );
    if (!existing) return { status: "kept-previous", reason: "no-previous" };
    await markTeamDigestStale(teamId);
    return { status: "kept-previous", reason: "empty" };
  }
  if (dropped > 0) {
    // Not fatal — the gate did its job — but a model that invents provenance
    // is a model that will invent facts, so the rate belongs in the logs.
    console.warn(
      `[memory-digest] team ${teamId}: dropped ${dropped.toString()} line(s) with unresolvable provenance`,
    );
  }

  const tokenCount = countTokens(content);
  await writeTeamDigest({
    organizationId,
    teamId,
    content,
    tokenCount,
    sourceFingerprint: inputs.fingerprint,
    sources: {
      memoryPaths: inputs.conventions.map((c) => c.path),
      episodeIds: [
        ...inputs.decisions.map((d) => d.id),
        ...inputs.threads.map((t) => t.id),
      ],
      recordIds: inputs.entities.map((e) => e.id),
    },
    modelProfileKey: generated.profileKey,
  });

  return { status: "written", tokenCount, dropped };
};
