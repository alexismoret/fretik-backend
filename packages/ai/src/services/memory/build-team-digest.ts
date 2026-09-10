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
/**
 * Nightly and debounced, so a slow model costs nothing a user can feel — and
 * an abort costs a whole day of freshness, which is the expensive half.
 *
 * 120 s was a guess and measured badly: on a team with fifteen linked entities,
 * **4 builds in 10 hit it** and kept the previous digest. Successful builds on
 * the same inputs land around 60–70 s, so the tail is what this has to cover,
 * not the median.
 */
const DIGEST_TIMEOUT_MS = 300_000;
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
- Under Key entities, write ONE line per entity, naming it, in prose. Its relations are given as \`subject — predicate → object\` triples: keep the subject the subject. Swapping the two ends inverts the fact.
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
 * Which input block owes which section, and the heading prefix that proves it
 * was written.
 *
 * A PREFIX, not the whole heading: the prompt gives each heading in full and
 * the model routinely shortens it to `## Conventions`. What has to be checked
 * is that the section exists at all — its exact wording is cosmetic.
 */
const SECTION_CONTRACT: readonly {
  present: (inputs: DigestInputs) => boolean;
  headingPrefix: string;
}[] = [
  { present: (i) => i.conventions.length > 0, headingPrefix: "## Conventions" },
  { present: (i) => i.entities.length > 0, headingPrefix: "## Key entities" },
  {
    present: (i) => i.decisions.length > 0,
    headingPrefix: "## Current decisions",
  },
  { present: (i) => i.threads.length > 0, headingPrefix: "## Open threads" },
];

/** Sections the inputs called for that the gated digest does not have. */
export const missingSections = (
  inputs: DigestInputs,
  content: string,
): string[] =>
  SECTION_CONTRACT.filter(
    (s) => s.present(inputs) && !content.includes(s.headingPrefix),
  ).map((s) => s.headingPrefix);

interface DigestSection {
  /** `null` for anything the model wrote before its first heading. */
  heading: string | null;
  lines: string[];
}

const splitSections = (lines: readonly string[]): DigestSection[] => {
  const sections: DigestSection[] = [];
  let current: DigestSection = { heading: null, lines: [] };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      sections.push(current);
      current = { heading: line, lines: [] };
    } else if (trimmed.length > 0) {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
};

/**
 * Render back, dropping every section left with nothing under it.
 *
 * Three ways a section empties: the prompt asks for sections with no input to
 * be omitted and the model emits them anyway (observed: an empty "## Open
 * threads" on a team with none), the marker gate drops its only line, or the
 * budget trim takes its last one. A heading carrying no claim spends prompt
 * budget on every turn of every member to say nothing.
 */
const renderSections = (sections: readonly DigestSection[]): string =>
  sections
    .filter((s) => s.lines.length > 0)
    .map((s) =>
      s.heading === null
        ? s.lines.join("\n")
        : [s.heading, ...s.lines].join("\n"),
    )
    .join("\n\n");

/**
 * Trim to budget by dropping the last line of the LARGEST section — never the
 * last line of the digest.
 *
 * Cutting from the tail spends the whole cut on whatever comes last, and the
 * section order that rightly puts conventions first also puts "current
 * decisions" and "open threads" last. Measured on a team with fifteen linked
 * entities: the entity list ate the budget and the digest lost its current
 * decisions outright in 2 generations out of 10 — silently, since a section
 * that never appears looks exactly like a team that has none. Every section
 * keeps a presence; the long tail of one is what pays.
 *
 * Still line-granular, and that is not cosmetic: cutting mid-marker hands the
 * agent a truncated id it will spend a tool call on for nothing — exactly the
 * trap the verbatim block's size cap already documents.
 */
const trimToBudget = (sections: readonly DigestSection[]): DigestSection[] => {
  const out = sections.map((s) => ({
    heading: s.heading,
    lines: [...s.lines],
  }));
  while (countTokens(renderSections(out)) > DIGEST_MAX_TOKENS) {
    let largest: DigestSection | undefined;
    for (const section of out) {
      if (section.lines.length > (largest?.lines.length ?? 0))
        largest = section;
    }
    if (!largest) break;
    largest.lines.pop();
  }
  return out;
};

/**
 * Drop every line whose marker the model invented, then trim to budget.
 *
 * Line-granular on purpose. `expandHandles` already blanks an unknown marker,
 * but a LINE that lost its marker is a claim with no provenance left — the one
 * shape the agent cannot check and the reader cannot trace. The prompt asks for
 * one marker per line precisely so this gate can work at that granularity.
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

  // Sections rather than lines from here on: rendering drops whatever is left
  // empty, so a stranded heading cannot outlive the trim by construction.
  return {
    content: renderSections(trimToBudget(splitSections(kept))).trim(),
    dropped,
  };
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
  | {
      status: "kept-previous";
      reason: "empty" | "truncated" | "incomplete" | "no-previous";
    };

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

  // Same rule as truncation, for the case `finishReason` does not catch: the
  // model stopped after one section and returned a well-formed, in-budget,
  // fully-attributed digest that happens to be missing two thirds of what it
  // was given. Measured at 1 in 10 — a 318-token digest holding conventions
  // and nothing else, on inputs carrying entities and a current decision.
  //
  // A section the digest never writes is indistinguishable, to every reader
  // downstream, from a team that has nothing to say there. That is a false
  // statement by omission, and it would be served on every turn until the next
  // successful run.
  const missing = missingSections(inputs, content);
  if (missing.length > 0) {
    console.warn(
      `[memory-digest] team ${teamId}: sections missing from the output (${missing.join(", ")}) — keeping the previous digest`,
    );
    if (!existing) return { status: "kept-previous", reason: "no-previous" };
    await markTeamDigestStale(teamId);
    return { status: "kept-previous", reason: "incomplete" };
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
