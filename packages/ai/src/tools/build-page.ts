import { describeRowTypes } from "@fretik/shared/services/pages/describe-row-types";
import type { Agent, ToolSet } from "ai";
import { z } from "zod";
import type { ChatbotCallOptions } from "../agents/chatbot";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import type { AgentRuntimeContext } from "../agents/shared/runtime-context";
import { createSubAgentExecute } from "../agents/shared/sub-agent";
import type { SalvageOutcome } from "./manage-page";
import { lastVueFence } from "./page-emitted-source";

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
 * data, writes a brief, reads the component APIs, writes the SFC, then RENDERS
 * the page in a browser and fixes what it sees, up to three rounds. It shares
 * the conversation's team scope and cannot delegate further.
 */

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
});

const pageRefSchema = z.object({
  pageId: z.string(),
  url: z.string().optional(),
});

/**
 * The builder's `managePage` actions that leave nothing behind — what makes a
 * dead run safe to retry (`hasSideEffect` below). Listed rather than derived
 * from the action enum on purpose: a new action must be classified by hand,
 * and the failure of forgetting is a build retried after it wrote, which is
 * worse than one not retried at all.
 */
const PAGE_BUILDER_READ_ACTIONS = new Set([
  "get_guide",
  "components",
  "dry_run",
  "get",
  "list",
  "stage",
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
      if (toolResult.toolName !== "managePage") continue;
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
 * A page source the builder wrote and never saved.
 *
 * The fence protocol (`page-emitted-source.ts`) makes this recoverable: the
 * SFC streams as ordinary text, so it is sitting in the trajectory of any run
 * that died between writing the file and claiming it — an upstream cut, the
 * step budget, the hard deadline. Before the protocol that source existed only
 * as tool-call arguments the transport had already thrown away, and the build
 * came back with nothing to show for its most expensive generation.
 *
 * Claimed is claimed: a successful `create`/`update` carrying code or edits at
 * or after the fence's step means the write landed, and re-saving over it would
 * undo whatever the review loop did next.
 */
export const findOrphanFence = (
  steps: BuildSteps,
): { source: string; stepIndex: number } | null => {
  let fence: { source: string; stepIndex: number } | null = null;
  for (const [index, step] of steps.entries()) {
    const source = lastVueFence(step.text);
    if (source !== null) fence = { source, stepIndex: index };
  }
  if (fence === null) return null;
  for (const [index, step] of steps.entries()) {
    if (index < fence.stepIndex) continue;
    const writes = new Set<string>();
    for (const call of step.toolCalls) {
      if (call.toolName !== "managePage") continue;
      if (typeof call.input !== "object" || call.input === null) continue;
      const action = Reflect.get(call.input, "action");
      if (action !== "create" && action !== "update") continue;
      const definition = Reflect.get(call.input, "definition");
      const wroteCode =
        typeof definition === "object" &&
        definition !== null &&
        Reflect.get(definition, "code") !== undefined;
      if (wroteCode || Reflect.get(call.input, "edits") !== undefined) {
        writes.add(call.toolCallId);
      }
    }
    for (const result of step.toolResults) {
      if (!writes.has(result.toolCallId)) continue;
      if (pageRefSchema.safeParse(result.output).success) return null;
    }
  }
  return fence;
};

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
  const actionByCall = new Map<string, string>();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (call.toolName !== "managePage") continue;
      if (typeof call.input !== "object" || call.input === null) continue;
      const action = Reflect.get(call.input, "action");
      if (typeof action === "string") {
        actionByCall.set(call.toolCallId, action);
      }
    }
  }
  for (const step of [...steps].reverse()) {
    for (const toolResult of [...step.toolResults].reverse()) {
      if (toolResult.toolName !== "managePage") continue;
      if (reviewRefSchema.safeParse(toolResult.output).success) return false;
      const action = actionByCall.get(toolResult.toolCallId);
      if (
        action !== undefined &&
        action !== "review" &&
        !PAGE_BUILDER_READ_ACTIONS.has(action)
      ) {
        return true;
      }
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
      if (toolResult.toolName !== "managePage") continue;
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
  salvaged?: SalvageOutcome,
): {
  summary: string;
  pageId?: string;
  url?: string;
  incomplete?: boolean;
  review?: z.infer<typeof reviewRefSchema>;
  reviewed?: false;
} => {
  const text = result.text.trim();
  /**
   * A rescued page is reported BEFORE anything else the run said about itself,
   * because nothing the run said knows about it: the builder died mid-write, so
   * its own trajectory names no page and every marker below would send the
   * parent off to rebuild one that now exists.
   */
  if (salvaged?.saved === true) {
    return {
      summary: `[recovered: the builder was cut off after writing the page but before saving it, so the source was saved for it. The page EXISTS and nobody has looked at it. Do NOT call buildPage again: run managePage { action: "review" } on it, apply what comes back with update { edits }, and hand back the url.]`,
      pageId: salvaged.pageId,
      url: salvaged.url,
      reviewed: false,
      incomplete: true,
    };
  }
  const ref = lastPageRef(result.steps);
  const review = lastReviewRef(result.steps);
  // Stated as a FIELD, not left to the summary: a build that reviewed nothing
  // and a build that reviewed and fell short read identically in prose.
  const outcome = review ? { review } : ref ? { reviewed: false as const } : {};
  if (result.finishReason === "stop" && text.length > 0) {
    return { summary: text, ...ref, ...outcome };
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
   * Save a page source outside a tool call — `savePageSource` in
   * `manage-page.ts`. Injected rather than imported so this module keeps no
   * runtime edge to the page services (and through them the database): every
   * branch above is decided from a trajectory, and that is what makes them
   * assertable from plain objects.
   */
  savePageSource: (params: {
    source: string;
    pageId?: string;
    teamId: string;
    organizationId: string;
    userId: string | null;
    conversationId?: string;
  }) => Promise<SalvageOutcome>;
}) => {
  const inputSchema = buildPageInputSchema;
  const formatResult = formatBuildResult;

  /**
   * Save what the run wrote but never claimed. Runs before the empty-run
   * retry, so a build that produced a whole page is finished rather than
   * started over — a rebuild from zero costs ~250s and reproduces the same
   * upstream risk on the same slow provider.
   */
  const salvage = async (
    result: BuildTrajectory,
    ctx: AgentRuntimeContext,
  ): Promise<SalvageOutcome | null> => {
    const orphan = findOrphanFence(result.steps);
    if (orphan === null) return null;
    const ref = lastPageRef(result.steps);
    console.error(
      `[build-page] unclaimed page source (${orphan.source.length.toString()} chars) — saving it`,
    );
    return await deps.savePageSource({
      source: orphan.source,
      ...(ref ? { pageId: ref.pageId } : {}),
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      userId: ctx.userId ?? null,
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    });
  };

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
    SalvageOutcome
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
    hasSideEffect: ({ toolName, input }) => {
      if (toolName !== "managePage") return true;
      const action =
        typeof input === "object" && input !== null && "action" in input
          ? (input as { action?: unknown }).action
          : undefined;
      return !PAGE_BUILDER_READ_ACTIONS.has(String(action));
    },
    progress,
    buildMessages: async ({ task, collectionKeys }, ctx) => {
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
      return [
        {
          role: "user",
          content:
            rowTypes.length > 0
              ? `${task}\n\n<collections>\n${rowTypes}\n</collections>`
              : task,
        },
      ];
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
    deadlineMs: 15 * 60 * 1000,
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
      "Build a page — the whole thing, by a specialist that can SEE what it made. It probes the data for real field names, writes the page's brief, reads the API of every component it uses, writes the Vue SFC, then renders the page in a real browser, clicks through it, and fixes what is broken before handing it back. Returns the url plus what it built and what is still weak.",
      "",
      "- Send it any page request beyond a one-line change: a new page, a new view or feature on an existing one, a redesign. `managePage` is for reading a page, a small targeted edit, and publishing — it has no `create`, so this is not a preference, it is the only route.",
      "- It carries the design doctrine, the runtime contract and the data-shape rules in its own prompt: there is NOTHING for you to read before calling it. Reading `skills/building-pages/references/` yourself buys the page nothing and costs a turn.",
      "- Put EVERYTHING in `task`: what the user asked for in their own words, the collections by name, the pageId when editing, and any constraint they stated. It never sees this conversation — what you omit, it decides for itself.",
      "- Send the SHAPE of the data, never its values. Type and field names, yes; totals and counts you queried, no. A page reads its own figures live, and a task that already answers the question invites a page that prints the answer instead of fetching it — one shipped showing a total the code never loaded.",
      "- Do not narrow the request on the user's behalf. A vague ask is not a small ask; the builder is built to expand it, and a task string that pre-trims it to a title and a table produces exactly that.",
      "- One call per page. A build runs long (data probe, then up to three render-and-fix rounds), so do not launch it in parallel with itself.",
      "- Hand back the url it returns, and repeat what it says is still weak rather than smoothing it over.",
      '- Trust `review` over the summary: `gate` is measured, `verdict` and `score` are judged, and they disagree routinely. Anything other than `verdict: "ship"` — or `reviewed: false`, meaning nobody looked at the page — is told to the user in one plain sentence, never as a checkmark.',
    ].join("\n"),
    inputSchema,
    execute,
  });
};
