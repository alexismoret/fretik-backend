import { describeRowTypes } from "@fretik/shared/services/pages/describe-row-types";
import type { Agent, ToolSet } from "ai";
import { z } from "zod";
import type { ChatbotCallOptions } from "../agents/chatbot";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import type { AgentRuntimeContext } from "../agents/shared/runtime-context";
import { createSubAgentExecute } from "../agents/shared/sub-agent";
import type { StepUsage } from "../lib/turn-usage";
import type { PageSalvageOutcome } from "../services/page-project/salvage";
import { describeExternalApps } from "./page-external-apps";

/**
 * `buildPage` — hand a whole page to the specialist that builds it.
 *
 * Its own tool rather than a mode of `dispatchAgent`, for three reasons that
 * all point the same way. The contracts differ: `dispatchAgent` caps parallel
 * fan-out, routes between a cheap and a primary model and returns a summary,
 * none of which means anything for one page returning one url. The cost
 * differs: `dispatchAgent` is a core tool whose description rides the cached
 * prefix of EVERY turn, and most turns build no page — this one is deferred
 * and costs nothing until `searchTools` surfaces it. And the moment of
 * decision differs: "should I delegate this page" is thought at the moment
 * `managePage` is reached for, which is exactly when this tool appears
 * alongside it.
 *
 * The page builder is a full agent (`agents/chatbot/index.ts`): it probes the
 * data, writes a brief, reads the component APIs, writes the project file by
 * file, then RENDERS the page in a browser and fixes what it sees. It shares
 * the conversation's team scope and cannot delegate further.
 */

/** A page reads a handful of apps, not a catalogue — and each skill is ~5k tokens. */
const MAX_EXTERNAL_APPS = 3;
/** Enough for a mockup and its data; more is a project, not a reference. */
const MAX_REFERENCE_FILES = 4;

export const buildPageInputSchema = z.object({
  task: z
    .string()
    .min(10)
    .describe(
      "Everything the user said about this page, plus what you know that it needs — the page's purpose, the data it must show, the collections by name, any layout or feature the user asked for by name, and the page id when editing an existing one. The builder never sees this conversation: what you leave out, it invents.",
    ),
  description: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "Short (3-5 word) label shown in traces and the UI. Example: 'Build deals dashboard'.",
    ),
  collectionKeys: z
    .array(z.string().min(1).max(60))
    .max(8)
    .optional()
    .describe(
      "Type keys from <team_collections> the page reads. Their fields and ids are handed to the builder up front, saving it a probe per type. List every type it will touch; a wrong key is reported back, not guessed at.",
    ),
  externalApps: z
    .array(z.string().min(1).max(60))
    .max(MAX_EXTERNAL_APPS)
    .optional()
    .describe(
      "Connected apps the page reads, by the key the connections list shows. The builder gets each one's skill and whether the team is actually connected — without it, it guesses the key and a wrong key reads as 'no data'.",
    ),
  referenceFiles: z
    .array(z.string().min(1).max(300))
    .max(MAX_REFERENCE_FILES)
    .optional()
    .describe(
      "Paths of files the user gave as a reference — a mockup, an export, a screenshot's description. The builder opens them with `read`. Pass the path, never the contents.",
    ),
});

const pageRefSchema = z.object({
  pageId: z.string(),
  url: z.string().optional(),
});

/**
 * The builder's tools that leave nothing behind — what makes a dead run safe to
 * retry (`hasSideEffect` below). Listed rather than derived, on purpose: a new
 * tool must be classified by hand, and the failure of forgetting is a build
 * retried after it wrote, which is worse than one not retried at all.
 *
 * `pageWrite` and `pageEdit` are NOT here even though they publish nothing:
 * they fill the run's working copy, and a retry that started over would write
 * its files on top of a project the first attempt had half-built.
 */
const PAGE_BUILDER_READ_TOOLS = new Set([
  "pageRead",
  "pageSearch",
  "pageProbe",
  "pageDocs",
  "read",
  "bash",
  "describeCollection",
  "listRecords",
  "getRecord",
  "listDocuments",
  "querySql",
  "searchIcons",
]);

const reviewRefSchema = z.object({
  gate: z.enum(["pass", "fail"]),
  verdict: z.string(),
  iteration: z.string(),
  score: z.number().optional(),
});

/**
 * How the last review actually ended, read from the builder's trajectory rather
 * than from the sentence it wrote about itself.
 *
 * The two are not the same thing. `gate: "pass"` with `verdict: "revise"` and a
 * 5.8 is an ordinary outcome — the measured checks cleared, the judged bar did
 * not — and the builder reported that combination to the user as "✅ Gate
 * Validée (Score : 5.8/10)". The prose is the builder's; these four fields are
 * the pipeline's, and the parent needs them to describe the page honestly.
 */
export const lastReviewRef = (
  steps: readonly {
    readonly toolResults: readonly { toolName: string; output: unknown }[];
  }[],
): z.infer<typeof reviewRefSchema> | undefined => {
  for (const step of [...steps].reverse()) {
    for (const toolResult of [...step.toolResults].reverse()) {
      if (toolResult.toolName !== "pageReview") continue;
      const parsed = reviewRefSchema.safeParse(toolResult.output);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
};

export type BuildSteps = readonly {
  /** What the model WROTE that step — where a ```vue fence lives. */
  readonly text: string;
  readonly toolCalls: readonly {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }[];
  readonly toolResults: readonly {
    toolCallId: string;
    toolName: string;
    output: unknown;
  }[];
}[];

/**
 * What `formatBuildResult` actually reads of a finished run. Declared
 * structurally rather than as `GenerateTextResult` so the branches can be
 * asserted from plain objects — a real result satisfies it.
 */
export interface BuildTrajectory {
  readonly finishReason: string;
  readonly text: string;
  readonly steps: BuildSteps;
}

/**
 * Whether the builder WROTE to the page after its last scored review — the one
 * fact that decides if that review still describes the page on the server.
 *
 * Measured 2026-08-23 (`page-dashboard-kpi-charts`): the builder passed review,
 * spent its remaining steps on elevation edits, and ran out before the closing
 * review. The old marker said only "may be unreviewed", so the parent re-ran a
 * FULL inspect→edit→review cycle on a page that had already been judged —
 * ~150s and two critic calls duplicating work the builder had done.
 *
 * Reads: walking the trajectory from the end, a scored review reached first
 * means nothing changed since it; a write reached first means the review is
 * stale. Read actions and unscored review attempts settle nothing and are
 * skipped.
 */
export const editedAfterLastReview = (steps: BuildSteps): boolean => {
  for (const step of [...steps].reverse()) {
    for (const toolResult of [...step.toolResults].reverse()) {
      if (toolResult.toolName === "pageReview") {
        // Shape probe, not validation — see above.
        if (z.validate(reviewRefSchema, toolResult.output)) return false;
        continue;
      }
      if (PAGE_BUILDER_READ_TOOLS.has(toolResult.toolName)) continue;
      // A write of any kind — a file, or the build that published it.
      return true;
    }
  }
  return false;
};

/**
 * The page the builder worked on, read from its own trajectory: the last
 * `managePage` result carrying a `pageId`.
 *
 * This is what lets the app open the finished page next to the conversation.
 * The panel keys on the IDENTIFIER, never on display text, and the builder's
 * summary is prose — so until this existed, the delegated path (the one both
 * tool descriptions recommend) was the one path whose page never opened.
 *
 * Read from the END: a build creates then edits then reviews, and all of those
 * name the same page. Error outputs (`{ error, code }`) carry no `pageId` and
 * fall through the schema check.
 */
export const lastPageRef = (
  steps: readonly {
    readonly toolResults: readonly { toolName: string; output: unknown }[];
  }[],
): { pageId: string; url: string } | undefined => {
  for (const step of [...steps].reverse()) {
    for (const toolResult of [...step.toolResults].reverse()) {
      if (
        toolResult.toolName !== "pageBuild" &&
        toolResult.toolName !== "pageReview"
      ) {
        continue;
      }
      const parsed = pageRefSchema.safeParse(toolResult.output);
      if (!parsed.success) continue;
      return {
        pageId: parsed.data.pageId,
        url: parsed.data.url ?? `/pages/${parsed.data.pageId}`,
      };
    }
  }
  return undefined;
};

/**
 * The four numbers a page's price comes down to, kept short because the parent
 * reads them verbatim. `steps` is the term that dominates: cost is linear in
 * model steps at a near-constant price each, so a build that got cheaper is a
 * build that took fewer of them.
 */
export interface BuildSpend {
  steps: number;
  costUsd: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Rounded so a tenth of a cent does not travel as sixteen digits. */
const summarizeSpend = (usage: StepUsage): BuildSpend => ({
  steps: usage.steps,
  costUsd: Number(usage.costUsd.toFixed(4)),
  outputTokens: usage.outputTokens,
  reasoningTokens: usage.reasoningTokens,
});

/**
 * The builder's own closing summary carries the url, what it built and what it
 * left weak. An unclean finish means the step budget ran out mid-build — usually
 * mid-review — so the page exists but nobody has confirmed it works. Saying that
 * plainly is the point: the parent must not hand a url to the user with an
 * implicit "it's been checked".
 *
 * Module-level so the branches below can be asserted without standing up an
 * agent — every one of them was written from a measured failure, and a branch
 * nothing pins is a branch that drifts.
 */
export const formatBuildResult = (
  result: BuildTrajectory,
  salvaged?: PageSalvageOutcome,
  usage?: StepUsage,
): {
  summary: string;
  pageId?: string;
  url?: string;
  incomplete?: boolean;
  review?: z.infer<typeof reviewRefSchema>;
  reviewed?: false;
  usage?: BuildSpend;
} => {
  const text = result.text.trim();
  /**
   * What the build cost, on the result itself.
   *
   * Four numbers, ~30 tokens, and they are the only place a page's price is
   * stated by the process that paid it — everything else has to ask Langfuse,
   * which is a pipeline reporting on us rather than a measurement of us. The
   * parent gets it so it can say "31 steps" honestly instead of guessing, and
   * the evals read it instead of summing observations.
   */
  const spend = usage === undefined ? {} : { usage: summarizeSpend(usage) };
  /**
   * A rescued page is reported BEFORE anything else the run said about itself,
   * because nothing the run said knows about it: the builder died mid-write, so
   * its own trajectory names no page and every marker below would send the
   * parent off to rebuild one that now exists.
   */
  if (salvaged?.saved === true) {
    return {
      summary: `[recovered: the builder was cut off after writing its files but before building them, so the build was finished for it. The page EXISTS and nobody has looked at it. Do NOT call buildPage again: run managePage { action: "review" } on it, apply what comes back with update { edits }, and hand back the url.]`,
      pageId: salvaged.pageId,
      url: salvaged.url,
      reviewed: false,
      incomplete: true,
      ...spend,
    };
  }
  const ref = lastPageRef(result.steps);
  const review = lastReviewRef(result.steps);
  // Stated as a FIELD, not left to the summary: a build that reviewed nothing
  // and a build that reviewed and fell short read identically in prose.
  const outcome = review ? { review } : ref ? { reviewed: false as const } : {};
  if (result.finishReason === "stop" && text.length > 0) {
    return { summary: text, ...ref, ...outcome, ...spend };
  }
  /**
   * A clean finish with NOTHING said. Measured 2026-08-24
   * (`page-filterable-directory`): the builder's last step ran 77s and
   * returned zero tokens — no text, no tool call — after creating the page
   * and scoring one review at 7.0. The run reported `stop`, so no marker
   * fired and the summary was the empty string; the parent read a result
   * with a `review` field and no words, and relaunched `buildPage` from
   * zero. That rebuild cost 454s and 33k tokens to reach a page that
   * already existed and only needed its remaining fix rounds.
   *
   * The empty-run net upstream (`sub-agent.ts`) cannot catch this one: the
   * build HAD side effects, so a retry from zero is exactly what must not
   * happen. What was missing is the sentence — with the page named, the
   * cheap remedy is the one the parent can already perform.
   */
  if (result.finishReason === "stop" && ref?.pageId !== undefined) {
    return {
      summary: `[incomplete: the builder returned no summary — its last step produced nothing. The page EXISTS and is saved. Do NOT call buildPage again: open it with managePage { action: "review" } to get its findings, apply them with update { edits }, and hand back the url.]`,
      ...ref,
      ...outcome,
      incomplete: true,
      ...spend,
    };
  }
  /**
   * Two different failures arrive with the same non-`stop` finish, and
   * telling them apart is what keeps the parent honest.
   *
   * Measured 2026-08-22 (`page-time-shape`): the builder hit a
   * reasoning-only zombie step (`finish=other`, logged by `agent-builder`)
   * and saved NOTHING — while this marker told the parent the page "may be
   * unreviewed" and to go review it. The agent duly hunted for a page that
   * did not exist, rebuilt from scratch, zombied again, and finally handed
   * the user an INVENTED page id. A message that assumes the good half of
   * its own failure does not degrade, it fabricates.
   *
   * The delegate now has the same first line of defence as the parent turn:
   * `fallbackSubAgent` retries an empty run once on the fallback model
   * (`agents/shared/sub-agent.ts`). This marker is what is left when even
   * that came back with nothing, so "call it again" is the remedy — bounded
   * on purpose, since a third empty build is a failure to report, not a loop
   * to spin.
   */
  const marker =
    ref?.pageId === undefined
      ? salvaged?.saved === false
        ? `[incomplete: the builder stopped at finishReason="${result.finishReason}" having written a page it never saved, and saving it here failed too — ${salvaged.reason}. There is nothing to open, review or link. Call buildPage once more with the same task.]`
        : `[incomplete: the builder stopped at finishReason="${result.finishReason}" and saved NO page — there is nothing to open, review or link. Call buildPage once more with the same task. If it comes back empty again, tell the user the build failed; never name a page this tool did not return.]`
      : review === undefined
        ? `[incomplete: the builder stopped at finishReason="${result.finishReason}" — the page exists but was never reviewed. Call managePage { action: "review" } on it before telling the user it is ready.]`
        : review.gate === "fail"
          ? `[incomplete: the builder stopped at finishReason="${result.finishReason}" — the page's last review failed its gate (round ${review.iteration}). Call managePage { action: "review" } for the blocking findings, fix them with update { edits }, and stop when the gate passes.]`
          : editedAfterLastReview(result.steps)
            ? `[incomplete: the builder stopped at finishReason="${result.finishReason}" — the page passed review (round ${review.iteration}) but was edited after it. Review it once to confirm the edits — if the review refuses because the budget is spent, hand back the url and name the unverified edits plainly.]`
            : `[incomplete: the builder stopped at finishReason="${result.finishReason}" — but the page already passed review (round ${review.iteration}). Do NOT review again: hand back the url, and pass any leftover findings on as next steps.]`;
  return {
    summary: text.length > 0 ? `${marker}\n\n${text}` : marker,
    ...ref,
    ...outcome,
    incomplete: true,
    ...spend,
  };
};

export const createBuildPageTool = <TTools extends ToolSet>(deps: {
  /**
   * Resolve the builder for THIS turn. A function, not an instance: the model
   * that writes a page is a per-turn decision (an A/B candidate, and in future
   * a per-team one), and holding an instance here is precisely what pinned
   * every page in the product to one profile from import time.
   */
  resolvePageBuilder: (
    profileKey?: string,
  ) => Agent<ChatbotCallOptions, TTools>;
  /**
   * The builder on its fallback model, for the one retry a build gets when it
   * comes back having produced nothing. See `fallbackSubAgent`.
   */
  resolvePageBuilderFallback: (
    profileKey?: string,
  ) => Agent<ChatbotCallOptions, TTools>;
  /**
   * Finish the build of a run that died before it could — `salvagePageProject`
   * in `services/page-project/salvage.ts`. Injected rather than imported so
   * this module keeps no runtime edge to the page services (and through them
   * the database): every branch above is decided from a trajectory, and that
   * is what makes them assertable from plain objects.
   */
  salvagePage: (params: {
    scope: string;
    teamId: string;
    organizationId: string;
    userId: string | null;
    conversationId?: string;
  }) => Promise<PageSalvageOutcome | null>;
}) => {
  const inputSchema = buildPageInputSchema;
  const formatResult = formatBuildResult;

  /**
   * Build what the run wrote but never built. Runs before the empty-run retry,
   * so a build that produced a whole project is finished rather than started
   * over — a rebuild from zero costs ~250s and reproduces the same upstream
   * risk on the same slow provider.
   *
   * The scope is the BUILDER's trace, which is where its working copy lives
   * (`buildCallOptions` below appends `.page`); with no trace the builder
   * keyed its copy by the conversation, and so does this.
   */
  const salvage = async (
    _result: BuildTrajectory,
    ctx: AgentRuntimeContext,
  ): Promise<PageSalvageOutcome | null> =>
    await deps.salvagePage({
      scope: ctx.traceId
        ? `${ctx.traceId}.page`
        : (ctx.conversationId ?? "no-run"),
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      userId: ctx.userId ?? null,
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    });

  /**
   * What the parent's card draws while the build runs.
   *
   * FACTS, not sentences: the tool the builder just reached for, and the
   * action when that tool has one. The wording is the browser's job — it has
   * both locales and this file has neither — and keeping it there also means a
   * new builder step needs no change on this side.
   *
   * `progress` is the discriminator: every preliminary yield carries it and
   * the final result never does, so the card can tell "still working" from
   * "here is your page" without depending on the SDK's `preliminary` flag
   * reaching the browser intact.
   */
  const progress = (event: {
    step: number;
    toolName: string;
    input: unknown;
  }): { progress: { step: number; tool: string; action?: string } } => {
    const action =
      typeof event.input === "object" && event.input !== null
        ? Reflect.get(event.input, "action")
        : undefined;
    return {
      progress: {
        step: event.step,
        tool: event.toolName,
        ...(typeof action === "string" ? { action } : {}),
      },
    };
  };

  const execute = createSubAgentExecute<
    ChatbotCallOptions,
    TTools,
    z.infer<typeof inputSchema>,
    ReturnType<typeof formatResult>,
    ReturnType<typeof progress>,
    PageSalvageOutcome
  >({
    salvage,
    subAgent: (ctx) => deps.resolvePageBuilder(ctx.pageBuildProfileKey),
    fallbackSubAgent: (ctx) =>
      deps.resolvePageBuilderFallback(ctx.pageBuildProfileKey),
    // What a retry must not duplicate. Everything the builder does before it
    // saves — the environment guide, a component API lookup, a dry run against
    // the data — leaves nothing behind, and a build that died in that opening
    // stretch is exactly the one worth attempting again. `review` counts as a
    // write: it stores a round of the page.
    hasSideEffect: ({ toolName }) => !PAGE_BUILDER_READ_TOOLS.has(toolName),
    progress,
    buildMessages: async (
      { task, collectionKeys, externalApps, referenceFiles },
      ctx,
    ) => {
      // Read the schema here, once, rather than letting the builder spend a
      // tool step per type on it. A failure is not worth the build: the types
      // are an accelerator, and the builder can still probe for itself.
      const rowTypes = collectionKeys?.length
        ? await describeRowTypes({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            keys: collectionKeys,
          }).catch(() => "")
        : "";
      // Same reasoning, one step further: a provider's key, its connection
      // state and its actions are things the builder cannot discover — it has
      // no `searchTools`, and a guessed key reads as "no data" (2026-08-26).
      const apps = externalApps?.length
        ? await describeExternalApps({
            keys: externalApps,
            conversationId: ctx.conversationId,
            teamId: ctx.teamId,
          }).catch(() => ({ block: null, unknown: [] as string[] }))
        : { block: null, unknown: [] as string[] };
      // PATHS, never contents: the builder opens them with `read`, which
      // slices and folds `data:` URIs. A mockup pasted into a task string is a
      // 30 kB line the model reads once and pays for on every step.
      const references = referenceFiles?.length
        ? [
            "<reference_files>",
            ...referenceFiles.map((path) => `- ${path}`),
            "Open each one in full with `read` before you design.",
            "</reference_files>",
          ].join("\n")
        : "";

      // Context first, the ask LAST. Google's own guidance for Gemini 3 is to
      // "place your specific instructions or questions at the end of the
      // prompt, after the data context" — and the blocks above are exactly
      // that context: the collections, the apps, the references. The task led
      // here until 2026-09-04 for no reason beyond it being what a person
      // would say first.
      const blocks = [
        rowTypes.length > 0 ? `<collections>\n${rowTypes}\n</collections>` : "",
        apps.block ?? "",
        apps.unknown.length > 0
          ? `<external_apps_unknown>\nNo connected app answers to: ${apps.unknown.join(", ")}. Do not declare a dataset over one of these.\n</external_apps_unknown>`
          : "",
        references,
        `<task>\n${task}\n</task>`,
      ].filter((block) => block.length > 0);

      return [{ role: "user", content: blocks.join("\n\n") }];
    },
    buildCallOptions: (_input, ctx) => ({
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      conversationId: ctx.conversationId,
      timeZone: ctx.timeZone,
      traceId: ctx.traceId ? `${ctx.traceId}.page` : undefined,
      workflowAutonomy: ctx.workflowAutonomy,
      toolPolicies: ctx.toolPolicies,
      // Carried so the builder can be repointed and steered per turn. Both were
      // absent until 2026-08-18: the page builder ran on the code default at
      // its profile's own reasoning default, whatever the turn had decided.
      pageBuildProfileKey: ctx.pageBuildProfileKey,
      reasoningLevel: ctx.reasoningLevel,
    }),
    formatResult,
    // Sized to catch a HANG, never to police slowness. The 2026-08-23 runs
    // proved that claim needs enforcing, not assuming: two of three builds hit
    // this wall mid-generation because every fix round was re-emitting the
    // whole page. The soft deadline in `sub-agent.ts` now tells the builder to
    // wrap up at 75% of this budget, so reaching the hard cut again means a
    // real hang — what it replaces is infinity (measured 2026-08-21, a stalled
    // in-process render held the parent turn open 45+ minutes).
    //
    // 15 → 25 minutes with the project model: a build is now many small calls
    // instead of three enormous ones, and each one that lands is kept in the
    // working copy. A cut here no longer loses a generation, so the budget can
    // cover a page of a dozen files without the wall arriving mid-page.
    deadlineMs: 25 * 60 * 1000,
    onDeadline: () => ({
      summary:
        '[incomplete: the build ran out of time — a step hung. The page may exist in an unreviewed state: call managePage { action: "list" } to check, and { action: "review" } before telling the user it is ready.]',
      incomplete: true,
    }),
  });

  return buildChatbotTool({
    category: "domain",
    searchHint:
      "build create page dashboard app interface view report visualise visualize custom ui mini-app screen design",
    isReadOnly: false,
    description: [
      "Build a page — the whole thing, by a specialist that can SEE what it made. It probes the data for real field names, writes the page's brief, reads the API of every component it uses, writes the project file by file, then renders the page in a real browser, clicks through it, and fixes what is broken before handing it back. Returns the url plus what it built and what is still weak.",
      "",
      "- Send it any page request beyond a one-line change: a new page, a new view or feature on an existing one, a redesign. `managePage` is for reading a page, a small targeted edit, and publishing — it has no `create`, so this is not a preference, it is the only route.",
      "- It carries the design doctrine, the runtime contract and the data-shape rules in its own prompt: there is NOTHING for you to read before calling it. Reading `skills/building-pages/references/` yourself buys the page nothing and costs a turn.",
      "- Put EVERYTHING in `task`: what the user asked for in their own words, the collections by name, the pageId when editing, and any constraint they stated. It never sees this conversation — what you omit, it decides for itself.",
      "- Name the `externalApps` the page reads and the `referenceFiles` the user gave you (paths — a mockup, an export). The builder cannot discover either: it has no tool search, so a provider key it guesses reads as 'no data', and a reference it never hears about is a reference it cannot follow.",
      "- Send the SHAPE of the data, never its values. Type and field names, yes; totals and counts you queried, no. A page reads its own figures live, and a task that already answers the question invites a page that prints the answer instead of fetching it — one shipped showing a total the code never loaded.",
      "- Do not narrow the request on the user's behalf. A vague ask is not a small ask; the builder is built to expand it, and a task string that pre-trims it to a title and a table produces exactly that.",
      "- One call per page. A build runs long — data probe, the files, then a review loop that gates, critiques once and gates again — so do not launch it in parallel with itself.",
      "- Hand back the url it returns, and repeat what it says is still weak rather than smoothing it over.",
      '- Trust `review` over the summary: `gate` is measured, `verdict` and `score` are judged, and they disagree routinely. Anything other than `verdict: "ship"` — or `reviewed: false`, meaning nobody looked at the page — is told to the user in one plain sentence, never as a checkmark.',
    ].join("\n"),
    inputSchema,
    execute,
  });
};
