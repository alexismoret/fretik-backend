import { parseApiError } from "@fretik/shared/schemas/errors";
import type { PageDefinition } from "@fretik/shared/schemas/pages";
import { createPage } from "@fretik/shared/services/pages/create";
import {
  formatPageLintFinding,
  lintErrorsRefusingBuild,
  lintPageDataContract,
  lintPageDesignPlan,
  lintPageProject,
} from "@fretik/shared/services/pages/lint";
import { updatePage } from "@fretik/shared/services/pages/update";
import type { PageVersionMeta } from "@fretik/shared/services/pages/versions";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { HTTPException } from "hono/http-exception";
import { readAgentUsage } from "../../lib/turn-usage";
import { PAGE_JSON_FILE, parsePageJson, type PageJson } from "./page-json";
import {
  codeFromProject,
  hashProjectFiles,
  projectFiles,
  type PageProjectState,
} from "./store";

/**
 * Compile a working copy and, only if it is green, make it the page.
 *
 * This is the seam the whole tool set is built around. Writing a file cannot
 * fail for being incomplete, because nothing it writes is published; building
 * is where the compiler, the data contract and the sanitiser get their say, and
 * a build that refuses leaves every file exactly where it was. The old shape
 * did the opposite — it refused the WRITE, discarding a 25 000-token emission
 * and asking for it again (measured 2026-08-23 as roughly half the builder's
 * output tokens).
 *
 * A service rather than only a tool, because it has a second caller: a run that
 * died after writing its files still has them in Redis, and finishing that
 * build is worth more than starting the whole thing over.
 */

/**
 * The page-building agent's id, shared with the agent that carries it
 * (`makePageBuilderSet`) so the name a step is filed under and the name this
 * reads back can never drift apart.
 */
export const PAGE_BUILDER_AGENT_ID = "chatbot.page-builder";

export interface BuildPageProjectInput {
  state: PageProjectState;
  teamId: string;
  organizationId: string;
  userId: string | null;
  conversationId: string | undefined;
  requester: PageRequester | undefined;
  /** The turn, so the version can be priced later (`PageVersionMeta.traceId`). */
  traceId?: string | undefined;
  /**
   * This build is finishing a run that died, not one the agent asked for.
   *
   * It relaxes exactly one thing: a page created without a design plan is
   * saved rather than refused. The plan is required so that a builder decides
   * the design before writing it — a rule that has no addressee once the
   * builder is gone, and enforcing it here would trade a page that exists for
   * nothing at all.
   */
  rescue?: boolean;
}

export type BuildPageProjectResult =
  | {
      ok: true;
      pageId: string;
      url: string;
      warnings: string[];
      /** True when the files were already what the stored page holds. */
      unchanged: boolean;
      /** The copy to persist: same files, now marked as built. */
      state: PageProjectState;
    }
  | { ok: false; errors: string[] };

/** What a page's `<h1>` gives when `page.json` names nothing. */
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const nameFromSource = (source: string): string | null => {
  const heading = H1_RE.exec(source)?.[1] ?? "";
  const text = heading
    .replace(/\{\{[\s\S]*?\}\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 120) : null;
};

/**
 * The refusal a page service throws, unwrapped into its own lines.
 *
 * Every 400 from `createPage`/`updatePage` lands here — a compile error, a
 * dataset over an app the team is not connected to, a call the bridge has
 * nothing to route to. They are all the same thing to the agent: named
 * problems that stopped the save, with the files untouched.
 */
const refusalLines = (error: unknown): string[] | null => {
  if (!(error instanceof HTTPException) || error.status !== 400) return null;
  const message = parseApiError(error.message)?.message;
  if (typeof message !== "string") return null;
  return message
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("Page code failed"));
};

export const buildPageProject = async (
  input: BuildPageProjectInput,
): Promise<BuildPageProjectResult> => {
  const { state } = input;
  const code = codeFromProject(state);

  if (code.source.trim().length === 0) {
    return {
      ok: false,
      errors: [
        "There is no Page.vue to build — the entry file is the page itself.",
      ],
    };
  }

  const raw = state.files[PAGE_JSON_FILE];
  const manifest = raw === undefined ? null : parsePageJson(raw);
  if (manifest !== null && !manifest.ok) {
    return { ok: false, errors: manifest.errors };
  }
  // A page with no `page.json` is legal: it declares nothing, reads nothing,
  // and renders whatever its code renders.
  const sections: PageJson = manifest?.value ?? {};

  /**
   * What this version cost, in our own row — the writes, what the builder had
   * spent, and the turn to cross-check both against. Omitted entirely when
   * there is none of it, so a restore or a hand-edit does not carry an empty
   * object.
   */
  const wrote = state.writes !== undefined && state.writes.length > 0;
  const spent = readAgentUsage(input.traceId, PAGE_BUILDER_AGENT_ID);
  const versionMeta: PageVersionMeta | undefined =
    wrote || spent !== undefined || input.traceId !== undefined
      ? {
          ...(wrote ? { writes: state.writes } : {}),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          ...(spent === undefined
            ? {}
            : {
                usage: {
                  steps: spent.steps,
                  costedSteps: spent.costedSteps,
                  costUsd: Number(spent.costUsd.toFixed(4)),
                  inputTokens: spent.inputTokens,
                  cacheReadTokens: spent.cacheReadTokens,
                  outputTokens: spent.outputTokens,
                  reasoningTokens: spent.reasoningTokens,
                  ...(Object.keys(spent.providers).length > 0
                    ? { providers: spent.providers }
                    : {}),
                },
              }),
        }
      : undefined;

  const definition: PageDefinition = {
    version: 3,
    ...(sections.brief !== undefined ? { brief: sections.brief } : {}),
    variables: sections.variables ?? [],
    datasets: sections.datasets ?? [],
    operations: sections.operations ?? [],
    ...(sections.theme !== undefined ? { theme: sections.theme } : {}),
    code,
  };

  // The lints that refuse, both checked BEFORE the compile because a page that
  // compiles and lies is exactly the thing every other gate lets through: rows
  // the team's data never produced, and — since 2026-09-04 — code that queries
  // datasets this definition does not declare. The second one is why the
  // sentence above about a page with no `page.json` is safe: declaring nothing
  // is legal only for a page that also asks for nothing.
  const lint = [
    ...lintPageProject(code),
    ...lintPageDataContract(code, {
      datasetIds: definition.datasets.map((dataset) => dataset.id),
      operationIds: definition.operations.map((operation) => operation.id),
    }),
    // Required only where there is still someone to write it: a page being
    // created by a live builder. A repair inherits whatever plan the page was
    // built with, and a rescue has no builder left to ask.
    ...lintPageDesignPlan(definition.brief, {
      required: state.pageId === undefined && input.rescue !== true,
    }),
  ];
  const refusals = lintErrorsRefusingBuild(lint);
  if (refusals.length > 0) {
    return { ok: false, errors: refusals };
  }

  const hash = hashProjectFiles(projectFiles(state));
  if (state.builtHash === hash && state.pageId !== undefined) {
    return {
      ok: true,
      pageId: state.pageId,
      url: `/pages/${state.pageId}`,
      warnings: [],
      unchanged: true,
      state,
    };
  }

  const name = sections.name ?? nameFromSource(code.source) ?? "Untitled page";

  try {
    const saved =
      state.pageId !== undefined
        ? await updatePage({
            pageId: state.pageId,
            teamId: input.teamId,
            actingUserId: input.userId ?? "",
            ...(input.requester !== undefined
              ? { requester: input.requester }
              : {}),
            input: {
              name,
              ...(sections.description !== undefined
                ? { description: sections.description }
                : {}),
              definition,
            },
            ...(input.conversationId !== undefined
              ? { sourceConversationId: input.conversationId }
              : {}),
            actor: {
              actor: "agent",
              userId: input.userId,
              conversationId: input.conversationId ?? null,
            },
            // What this version cost to write, in our own row. See
            // `PageVersionMeta.writes` for why it cannot live in telemetry.
            ...(versionMeta === undefined ? {} : { versionMeta }),
          })
        : await createPage({
            teamId: input.teamId,
            organizationId: input.organizationId,
            createdByUserId: input.userId ?? "",
            input: {
              name,
              description: sections.description ?? "",
              definition,
              ...(input.conversationId !== undefined
                ? { sourceConversationId: input.conversationId }
                : {}),
            },
            actor: {
              actor: "agent",
              userId: input.userId,
              conversationId: input.conversationId ?? null,
            },
            ...(versionMeta === undefined ? {} : { versionMeta }),
          });

    return {
      ok: true,
      pageId: saved.page.id,
      url: `/pages/${saved.page.id}`,
      // The lints that do not refuse ride with the save's own warnings: a
      // native control fails the review, so hearing it here is one edit
      // instead of a render.
      warnings: [...saved.warnings, ...lint.map(formatPageLintFinding)],
      unchanged: false,
      state: { ...state, pageId: saved.page.id, builtHash: hash },
    };
  } catch (error) {
    const errors = refusalLines(error);
    // Not a refusal we can explain: a bug, a database that is down. It belongs
    // in the logs and the tool backstop, not in a list of things to fix.
    if (errors === null) throw error;
    return { ok: false, errors };
  }
};
