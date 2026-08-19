import type { Agent, GenerateTextResult, ToolSet } from "ai";
import { z } from "zod";
import type { ChatbotCallOptions } from "../agents/chatbot";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import { createSubAgentExecute } from "../agents/shared/sub-agent";

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
      "Everything the user said about this page, plus what you know that it needs — the page's purpose, the data it must show, the object types by name, any layout or feature the user asked for by name, and the page id when editing an existing one. The builder never sees this conversation: what you leave out, it invents.",
    ),
  description: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "Short (3-5 word) label shown in traces and the UI. Example: 'Build deals dashboard'.",
    ),
});

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
}) => {
  const inputSchema = buildPageInputSchema;

  /**
   * The builder's own closing summary carries the url, what it built and what
   * it left weak. An unclean finish means the step budget ran out mid-build —
   * usually mid-review — so the page exists but nobody has confirmed it works.
   * Saying that plainly is the point: the parent must not hand a url to the
   * user with an implicit "it's been checked".
   */
  const formatResult = (
    result: GenerateTextResult<TTools, Record<string, unknown>, never>,
  ): { summary: string; incomplete?: boolean } => {
    const text = result.text.trim();
    if (result.finishReason === "stop") return { summary: text };
    const marker = `[incomplete: the builder stopped at finishReason="${result.finishReason}" — the page may be unreviewed or half-fixed. Call managePage { action: "review" } on it before telling the user it is ready.]`;
    return {
      summary: text.length > 0 ? `${marker}\n\n${text}` : marker,
      incomplete: true,
    };
  };

  const execute = createSubAgentExecute<
    ChatbotCallOptions,
    TTools,
    z.infer<typeof inputSchema>,
    ReturnType<typeof formatResult>
  >({
    subAgent: (ctx) => deps.resolvePageBuilder(ctx.pageBuildProfileKey),
    buildMessages: ({ task }) => [{ role: "user", content: task }],
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
  });

  return buildChatbotTool({
    category: "domain",
    searchHint:
      "build create page dashboard app interface view report visualise visualize custom ui mini-app screen design",
    isReadOnly: false,
    description: [
      "Build a page — the whole thing, by a specialist that can SEE what it made. It probes the data for real field names, writes the page's brief, reads the API of every component it uses, writes the Vue SFC, then renders the page in a real browser, clicks through it, and fixes what is broken before handing it back. Returns the url plus what it built and what is still weak.",
      "",
      "- Send it any page request beyond a one-line change: a new page, a new view or feature on an existing one, a redesign. `managePage` is for reading a page, a small targeted edit, and publishing.",
      "- Put EVERYTHING in `task`: what the user asked for in their own words, the object types by name, the pageId when editing, and any constraint they stated. It never sees this conversation — what you omit, it decides for itself.",
      "- Send the SHAPE of the data, never its values. Type and field names, yes; totals and counts you queried, no. A page reads its own figures live, and a task that already answers the question invites a page that prints the answer instead of fetching it — one shipped showing a total the code never loaded.",
      "- Do not narrow the request on the user's behalf. A vague ask is not a small ask; the builder is built to expand it, and a task string that pre-trims it to a title and a table produces exactly that.",
      "- One call per page. A build runs long (data probe, then up to three render-and-fix rounds), so do not launch it in parallel with itself.",
      "- Hand back the url it returns, and repeat what it says is still weak rather than smoothing it over.",
    ].join("\n"),
    inputSchema,
    execute,
  });
};
