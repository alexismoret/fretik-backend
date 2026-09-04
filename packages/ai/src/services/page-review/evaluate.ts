import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import type { PageBrief } from "@fretik/shared/schemas/pages";
import type {
  PageRenderInteraction,
  PageRenderShot,
} from "@fretik/shared/services/pages/render/types";
import { generateText, type ModelMessage } from "ai";
import { join } from "node:path";
import { z } from "zod";
import { describeLlmError } from "../../lib/describe-llm-error";
import { telemetryFor } from "../../lib/langfuse";
import {
  resolveModel,
  resolveModelForRoleProfile,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import { BUNDLED_SKILLS_DIR } from "../../skills/paths";

/**
 * The judged half of a review: a critic that did not build the page, looking
 * at what it actually renders.
 *
 * Two properties do the work, and both are structural rather than prompted.
 * The critic runs on a FRESH context — it never sees the source, the
 * conversation, or its own earlier verdicts, because a model asked to grade
 * its own output grades it generously and a model shown the code reviews the
 * code instead of the screen. And it does not decide anything: it returns four
 * scores and a list of findings, while the weighting, the threshold and the
 * ship/revise call are computed here. A critic that cannot declare victory
 * cannot hack its way to one.
 *
 * The rubric is the skill's own `references/review-rubric.md` — one file read
 * by both sides, so the page is judged on the terms it was built to.
 */

/**
 * The critic, resolved once per profile key.
 *
 * Overridable because "who judges" is a measurement question, not only a
 * production one: when an A/B pins the BUILDER to a profile, a critic from that
 * same family scores its own family's work — the self-review the whole role
 * exists to avoid — and the arm reads high for the wrong reason. The harness
 * pins a neutral critic for the run; production passes nothing and gets the
 * `page-review` binding.
 */
const criticFor = (profileKey?: string): ResolvedModel =>
  profileKey === undefined
    ? resolveModel("page-review")
    : resolveModelForRoleProfile("page-review", profileKey);

/**
 * Design carries the most weight because it is what the user cannot fix
 * themselves; originality is deliberately a fifth of the score rather than a
 * tiebreak, since a page that scores well everywhere else and could have been
 * generated for any dataset is the exact failure this review exists to catch.
 */
export const CRITIQUE_WEIGHTS = {
  design: 0.35,
  functionality: 0.25,
  craft: 0.2,
  originality: 0.2,
} as const;

/**
 * Weighted score a page must reach to ship. Also stated in the rubric.
 *
 * 7.5 until the loop could do something about a page that was merely
 * competent. With `elevations` routed out of the review, the bar was as high
 * as the loop could act on: above it, a page with no findings had nowhere to
 * go but out the door. Now an elevation round exists, so the bar moves to
 * where "worth showing someone" actually sits on the rubric — the top of the
 * 7-8 band, not its floor.
 *
 * Held against the critic's own spread (±0.5-1.0 on identical bytes), one
 * point of design moves the weighted score by 0.35. So this threshold is a
 * direction, and what it must never become is a per-round verdict read as
 * precise: the eval design AVERAGE across cases is what says whether it moved.
 */
export const SHIP_SCORE = 8;

/** Applied here rather than asked for: the model reports four observations,
 * the product decides what they are worth. */
export const weightedScore = (scores: CritiqueScores): number =>
  Math.round(
    (scores.design * CRITIQUE_WEIGHTS.design +
      scores.functionality * CRITIQUE_WEIGHTS.functionality +
      scores.craft * CRITIQUE_WEIGHTS.craft +
      scores.originality * CRITIQUE_WEIGHTS.originality) *
      10,
  ) / 10;

/** Gemini 3.x reasons before answering and it counts against the cap. */
const MAX_OUTPUT_TOKENS = 16_000;
/**
 * Reasoning is mandatory on this family, and this is a JUDGEMENT task — the
 * one kind where thinking earns its tokens. `medium` rather than the `low` the
 * extract engine pins: that pin answers a failure this call cannot have (bulk
 * extraction at `medium` plans in thought summaries and emits one record of
 * twenty-eight, under a 60k cap shared with the answer). A critique is ~1.5k
 * tokens against a 16k cap, so the cost of the deeper setting is a fraction of
 * a cent per review and truncation is surfaced below rather than guessed at.
 */
const CRITIC_PROVIDER_OPTIONS = {
  openrouter: { reasoning: { effort: "medium" as const } },
};
/** Three screenshots plus reasoning; the call is off the user's hot path. */
const TIMEOUT_MS = 180_000;
/**
 * Past this the list stops being a fix list and becomes a mood.
 *
 * 12 → 6 on 2026-09-03, with the loop: there is ONE critique per build now, and
 * its majors are applied once. A list of twelve was a list nobody finished — the
 * measured rounds spent their edits on the tail while the top of the list came
 * back unchanged. Six forces the critic to rank.
 */
const MAX_FINDINGS = 6;
/** One round can absorb three real improvements; a longer list is a wish list. */
const MAX_ELEVATIONS = 3;

const CritiqueSchema = z.object({
  scores: z.object({
    design: z.number().min(0).max(10),
    functionality: z.number().min(0).max(10),
    craft: z.number().min(0).max(10),
    originality: z.number().min(0).max(10),
  }),
  summary: z.string().max(400),
  findings: z
    .array(
      z.object({
        severity: z.enum(["major", "minor"]),
        where: z.string().max(160),
        problem: z.string().max(400),
        fix: z.string().max(400),
      }),
    )
    .max(MAX_FINDINGS)
    .default([]),
  /**
   * The second channel, and the reason this critic stopped being a rubber
   * stamp. Findings are defects, so a page with no defect produced nothing —
   * and measured across four reviews, every page that merely worked came back
   * with four eights and a compliment. A page that works always has a next
   * level; asking for it is what turns "ship" into "ship, and here is the one
   * change that would make someone remember it".
   */
  elevations: z
    .array(
      z.object({
        where: z.string().max(160),
        change: z.string().max(400),
        gain: z.string().max(240),
      }),
    )
    .max(MAX_ELEVATIONS)
    .default([]),
});

export type PageFinding = z.infer<typeof CritiqueSchema>["findings"][number];
export type PageElevation = z.infer<
  typeof CritiqueSchema
>["elevations"][number];
export type CritiqueScores = z.infer<typeof CritiqueSchema>["scores"];

export interface PageCritique {
  scores: CritiqueScores;
  /** Weighted, rounded to one decimal — computed here, never by the model. */
  score: number;
  summary: string;
  findings: PageFinding[];
  elevations: PageElevation[];
  model: string;
}

export type PageCritiqueResult =
  { ok: true; critique: PageCritique } | { ok: false; reason: string };

let rubricPromise: Promise<string> | null = null;
const readRubric = (): Promise<string> => {
  rubricPromise ??= Bun.file(
    join(
      BUNDLED_SKILLS_DIR,
      "building-pages",
      "references",
      "review-rubric.md",
    ),
  ).text();
  return rubricPromise;
};

const INSTRUCTIONS = [
  "You are reviewing a page built for a business team by another agent. You did not build it, you owe its author nothing, and your job is to be the last person who looks at it before its users do.",
  "Start from the assumption that it is mediocre and let the screenshots change your mind. A page that renders correctly and decides nothing scores 5 — that is the middle of the scale, not a failing grade, and most pages belong there. Reserve 9 and 10 for work you would show someone.",
  "You see what the page renders, never its source. Judge the screen. Every finding names where it is on screen, what is wrong, and what to do instead — and, when the file list below makes it obvious, which file it lives in.",
  "Report only what you can see. Do not repeat anything listed as already known.",
  "The data is live and it is the team's, not yours. A dataset with no rows today is a legitimate state of a working page, not a defect — judge whether the page explains itself and offers the way forward when it is empty, never how much data happens to exist right now. Never ask for more data, more records, or a fuller example.",
  "Answer with a single JSON object and nothing else:",
  '{ "scores": { "design": 0-10, "functionality": 0-10, "craft": 0-10, "originality": 0-10 }, "summary": "one sentence on what this page is and where it stands", "findings": [ { "severity": "major" | "minor", "where": "...", "problem": "...", "fix": "..." } ], "elevations": [ { "where": "...", "change": "...", "gain": "..." } ] }',
  '"major" is something a user would HIT — a control that misleads, a figure that cannot be read, a region that breaks at a width; "minor" is polish. Only the majors get applied, so a major you would not stop a release for is a minor. Order them by severity, at most four that matter, and an empty list is a real answer when nothing on the page is wrong.',
  "`elevations` is the other question, and it is not the same one: not what is broken, but what would make this page better than it is. At most three, ordered by how much they change the page, each naming where on screen it goes, the concrete change, and what the reader gains. Return at least one whenever the page scores below 9 — a page with no defects still has a next level, and this is where it is written down. Reach for the change that is specific to THIS subject: the value that should wear its own colour, the figure that should carry its comparison, the region that should be denser or larger, the view the data supports and the page does not offer. Never propose more data.",
].join("\n");

/**
 * The plan the page committed to, in the words its builder wrote.
 *
 * The design half used to be three prose lines and the critic had no way to
 * disagree with them. It is a plan now — an archetype, a hierarchy, a decision
 * about where depth opens, and a list of the generated defaults this page said
 * it would NOT take — and each of those is a claim a screenshot can contradict.
 * `defaultsRejected` is the sharpest: a page that named "four equal KPI cards"
 * as the thing it was avoiding, and shipped four equal KPI cards, has told the
 * critic exactly where to look.
 */
const describeBrief = (brief: PageBrief | undefined): string => {
  if (brief === undefined) {
    return [
      "## no brief",
      "This page was built without a written brief, so judge it on its own terms: what does it look like it is for, and does it do that well.",
    ].join("\n");
  }
  const design = brief.design;
  return [
    "## what this page was supposed to be",
    `Job: ${brief.product.job}`,
    `Audience: ${brief.product.audience}`,
    ...(brief.product.features.length > 0
      ? [`Promised: ${brief.product.features.join("; ")}`]
      : []),
    ...(design.archetype ? [`Shape: ${design.archetype}`] : []),
    `Layout: ${design.layout}`,
    ...(design.grid ? [`Grid: ${design.grid}`] : []),
    ...(design.hierarchy ? [`Hierarchy: ${design.hierarchy}`] : []),
    ...(design.density ? [`Density: ${design.density}`] : []),
    ...(design.containers ? [`Depth opens: ${design.containers}`] : []),
    `Signature: ${design.signature}`,
    ...(design.motion ? [`Motion: ${design.motion}`] : []),
    ...(design.states ? [`States: ${design.states}`] : []),
    ...(design.defaultsRejected && design.defaultsRejected.length > 0
      ? [`Defaults it rejected: ${design.defaultsRejected.join("; ")}`]
      : []),
    "",
    "Score it against this plan as much as against the rubric: a page that quietly dropped what it promised is not finished, however good the part it kept. Where it named a default it was avoiding, check the screen for that default — a plan is worth nothing if the page it describes is the one that would have been built anyway.",
  ].join("\n");
};

/**
 * The overlays the click pass opened, as text — alongside their captures.
 *
 * The two answer different questions and neither replaces the other: the tree
 * says what is IN a panel (is there anything, does it name its fields as
 * database keys, can it be acted on), the capture says what it LOOKS like. This
 * block used to be the only one of the pair, and the result was measurable —
 * pages whose own layout scored well shipped with modals that did not, because
 * no judge in the loop had ever seen one.
 */
const describeOverlays = (
  interactions: readonly PageRenderInteraction[] | undefined,
): { type: "text"; text: string }[] => {
  const opened = (interactions ?? []).filter(
    (interaction) =>
      interaction.overlaySnapshot !== undefined &&
      interaction.overlaySnapshot.length > 0,
  );
  if (opened.length === 0) return [];
  return [
    {
      type: "text",
      text: [
        "## overlays opened during the click pass",
        "Structure: one indented line per element, with its own text, input types and placeholders. The `overlay-*` captures below show these same panels — read the two together. Judge them as part of the page: an overlay that opens with a title and nothing else, one that names its fields as database keys, one with no way to act on what it shows, or one whose layout is visibly cruder than the page behind it is a defect of the page, and belongs in `findings` like any other.",
        ...opened.map(
          (interaction) =>
            `### ${interaction.target}\n\`\`\`\n${interaction.overlaySnapshot ?? ""}\n\`\`\``,
        ),
      ].join("\n\n"),
    },
  ];
};

const describeShot = (shot: PageRenderShot): string => {
  if (shot.label === "mobile") {
    return `### ${shot.label} — ${shot.width.toString()}px wide. A narrow layout, not a squeezed wide one: columns stack, tables become readable rows or scroll inside their own region.`;
  }
  if (shot.label === "desktop-mid") {
    return `### ${shot.label} — the SAME page, halfway down. It is here only because the page runs more than two and a half screens deep, so this band is one nobody would ever see in a single capture: judge whether the sections here still belong to the page above them, or whether it has turned into a stack of unrelated blocks that lost its subject partway.`;
  }
  if (shot.label === "desktop-bottom") {
    return `### ${shot.label} — the SAME page, scrolled to its end. Everything here is below the fold on arrival. A region that grows with its data belongs in a bounded, scrollable area with whatever orients the reader pinned to its edge; a table whose header scrolled away, a list that pushed the rest of the page off the screen, and a stranded footer of empty space all show up here and nowhere else.`;
  }
  if (shot.label === "tablet") {
    return `### ${shot.label} — ${shot.width.toString()}px wide, a laptop window. The same page one breakpoint down: a grid that was one row of four here becomes two rows of two, and any region given a fixed height for the wide layout now splits that height between rows. Judge whether the layout still holds its shape, or merely survives.`;
  }
  if (shot.label === "empty-state") {
    return `### ${shot.label} — the same page with every dataset returning zero rows. This is day one, and any day a filter matches nothing. It should still explain itself and offer the way forward.`;
  }
  if (shot.label.startsWith("route:")) {
    const path = shot.label.slice("route:".length);
    const how =
      shot.caption === undefined
        ? "opened directly, the way a shared link opens it"
        : `reached by clicking ${shot.caption}`;
    return `### ${shot.label} — another view of this same page, at ${path}, ${how}. It is not a secondary screen: someone will arrive here from a link with none of the first screen's context, so it is held to the same bar. Does it say where the reader is, give them a way back, answer its own question rather than repeating the list they came from — and read as the same product as the first capture?`;
  }
  if (shot.label.startsWith("overlay")) {
    return `### ${shot.label} — the panel that opened on clicking ${shot.caption ?? "a control"}, captured while it was open. It is part of the page and held to the same bar: its own spacing, hierarchy and states, not a looser standard because it sits on top.`;
  }
  // Never promises rows: the datasets are live, and a team whose records are
  // still empty would otherwise have its page marked down for their absence.
  return `### ${shot.label} — ${shot.width.toString()}×${shot.height.toString()}, the page as someone arrives on it, over whatever the team's data holds today.`;
};

export interface PageCritiqueInput {
  pageName: string;
  brief: PageBrief | undefined;
  shots: PageRenderShot[];
  /** Gate findings — stated so the critic spends its attention elsewhere. */
  known: string[];
  /**
   * The click pass's results, for the overlays it managed to open. The critic
   * sees the page with every panel dismissed, so without these the half of a
   * page that lives behind a click is judged by nobody.
   */
  interactions?: readonly PageRenderInteraction[];
  /**
   * The project's manifest — path, size, what each file exposes.
   *
   * Not the code: the critic judges the screen, and source would let it grade
   * what it read instead of what a user sees. What the file list buys is a
   * finding that names the file to open, which is the difference between one
   * edit and a search.
   */
  files?: string;
}

/**
 * Everything the critic is shown, assembled — exported so what reaches it can
 * be asserted without paying for a completion.
 *
 * The ORDER is part of the message: the overlay block points at the
 * `overlay-*` captures as "below", which holds only while it sits above
 * `## captures`. An overlay that reached neither this array nor a capture is a
 * panel no judge in the loop has ever seen.
 */
export const buildCritiqueContent = async (
  params: PageCritiqueInput,
): Promise<ModelMessage[]> => [
  {
    role: "user",
    content: [
      { type: "text", text: await readRubric() },
      {
        type: "text",
        text: `# The page under review\n\nName: ${params.pageName}\n\n${describeBrief(params.brief)}`,
      },
      ...(params.files !== undefined && params.files.length > 0
        ? [
            {
              type: "text" as const,
              // `uses:` is the one thing here that is not navigation. It says
              // which components the page reached for out of the hundred and
              // seventeen it had, and it is how a finding stops being "this
              // feels flat" and becomes "this list of dated events is a stack
              // of divs; it is a timeline". Name the file AND the component.
              text: `## files of this page, and the components each one places\n${params.files}`,
            },
          ]
        : []),
      ...(params.known.length > 0
        ? [
            {
              type: "text" as const,
              text: `## already known — do not report these again\n${params.known.map((line) => `- ${line}`).join("\n")}`,
            },
          ]
        : []),
      ...describeOverlays(params.interactions),
      { type: "text", text: "## captures" },
      ...params.shots.flatMap((shot) => [
        { type: "text" as const, text: describeShot(shot) },
        {
          type: "file" as const,
          data: shot.png,
          mediaType: "image/png",
        },
      ]),
    ],
  },
];

export const evaluatePageDesign = async (
  params: PageCritiqueInput & {
    /** Override the critic (harness A/Bs only — see `criticFor`). */
    criticProfileKey?: string;
  },
): Promise<PageCritiqueResult> => {
  if (params.shots.length === 0) {
    return { ok: false, reason: "no screenshots were captured" };
  }
  const critic = criticFor(params.criticProfileKey);

  const content = await buildCritiqueContent(params);

  let raw = "";
  let truncated = false;
  // A rate-limited critic gets two more tries before the caller hears about
  // it: on 2026-08-23 a single upstream 429 (2s) cost a build one of its three
  // review rounds. Anything other than a rate limit surfaces immediately.
  for (let attempt = 1; ; attempt++) {
    try {
      const { text, finishReason } = await generateText({
        model: critic.model,
        instructions: INSTRUCTIONS,
        messages: content,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        // Nests under the `managePage` tool call → under `chatbot-turn`.
        telemetry: telemetryFor("page-review"),
        providerOptions: CRITIC_PROVIDER_OPTIONS,
      });
      raw = text;
      truncated = finishReason === "length";
      break;
    } catch (error) {
      const reason = describeLlmError(error);
      if (attempt >= 3 || !/rate.?limit/i.test(reason)) {
        return { ok: false, reason };
      }
      await Bun.sleep(10_000 * attempt);
    }
  }

  // Free-form JSON, not constrained decoding: the same Gemini route bails
  // bimodally under `response_format: json_schema` (see `structured-extract`).
  const parsed = CritiqueSchema.safeParse(parseLlmJsonObject(raw));
  if (!parsed.success) {
    // Two different failures, and telling them apart is what makes the reason
    // actionable: a cap hit is ours to raise, anything else is the model.
    return {
      ok: false,
      reason: truncated
        ? "the critique ran past its output budget before it finished"
        : "the critic did not return a readable verdict",
    };
  }

  const { scores } = parsed.data;

  return {
    ok: true,
    critique: {
      scores,
      score: weightedScore(scores),
      summary: parsed.data.summary,
      findings: parsed.data.findings,
      elevations: parsed.data.elevations,
      model: critic.profile.catalog.id,
    },
  };
};
