import {
  PAGE_ENTRY_FILE,
  PAGE_FILE_PATH_RE,
} from "@fretik/shared/schemas/pages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { getPage } from "@fretik/shared/services/pages/retrieve";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { getRuntimeContext } from "../../agents/shared/runtime-context";
import { renderProjectManifest } from "../../services/page-project/manifest";
import { PAGE_JSON_FILE } from "../../services/page-project/page-json";
import {
  emptyProjectState,
  projectFromDefinition,
  readPageProject,
  writePageProject,
  type PageProjectState,
} from "../../services/page-project/store";

/**
 * What every `page*` tool needs before it can do anything: who is asking, which
 * run this is, and the files as they currently stand.
 *
 * The working copy is keyed by the builder's scope, which is the TURN's trace
 * id plus a constant `.page` suffix — so every build of one turn shares one
 * copy, one pageId and one review budget. This docblock claimed the opposite
 * until 2026-09-06 ("a builder dispatch has its own trace id"); it does not,
 * and `buildPage` refuses a second dispatch onto a page the turn already made
 * rather than resuming it blind (`admitBuildForTurn`).
 *
 * A tool that finds no copy for a page that already exists seeds one from what
 * is stored, which is what makes a repair start from the real page rather than
 * from nothing.
 */

export interface PageProjectContext {
  teamId: string;
  userId: string | null;
  organizationId: string;
  conversationId: string | undefined;
  /**
   * The builder's scope — the turn's trace plus `.page`. Keys the working
   * copy, and it is the SAME for every build of a turn: a second dispatch
   * resumes the first one's files rather than starting beside them.
   */
  scope: string;
  /**
   * The TURN — the builder's `${traceId}.page` stripped back to its parent, so
   * a delegate and the agent that dispatched it share ONE review budget. Keyed
   * per-agent they had one each, and a three-round budget measured five rounds
   * (2026-08-23).
   */
  reviewScope: string | undefined;
  requester: PageRequester | undefined;
  state: PageProjectState;
  save: (next: PageProjectState) => Promise<void>;
}

export const loadPageProjectContext = async (
  options: { context?: unknown; runtimeContext?: unknown },
  pageId?: string,
): Promise<PageProjectContext> => {
  const ctx = getRuntimeContext(options);
  const scope = ctx.traceId ?? ctx.conversationId ?? "no-run";
  const reviewScope = ctx.traceId?.split(".")[0] ?? ctx.conversationId;
  // A private page is invisible to anyone but its owner (org admins see
  // everything) — the same rule as the API and the UI.
  const requester: PageRequester | undefined = ctx.userId
    ? {
        userId: ctx.userId,
        isAdmin: await isOrgAdmin(ctx.organizationId, ctx.userId),
      }
    : undefined;

  let state = (await readPageProject(scope)) ?? emptyProjectState();
  const target = pageId ?? state.pageId;
  // A run that opens a page it has not touched starts from what is stored.
  // Without this a repair would begin on an empty project and "rewrite" the
  // page by omission.
  if (
    target !== undefined &&
    (state.pageId !== target || Object.keys(state.files).length === 0)
  ) {
    const page = await getPage({
      pageId: target,
      teamId: ctx.teamId,
      ...(requester !== undefined ? { requester } : {}),
    });
    state = projectFromDefinition(page.definition, {
      id: page.id,
      name: page.name,
      description: page.description,
    });
  }

  return {
    teamId: ctx.teamId,
    userId: ctx.userId ?? null,
    organizationId: ctx.organizationId,
    conversationId: ctx.conversationId,
    scope,
    reviewScope,
    requester,
    state,
    save: (next) => writePageProject(scope, next),
  };
};

/** The project as the model should see it after a call that changed it. */
export const manifestOf = (state: PageProjectState): string =>
  renderProjectManifest(state.files);

/** `NNN\t<line>` — the read format every code agent has seen. */
export const numberLines = (content: string, from = 1): string =>
  content
    .split("\n")
    .map(
      (line, index) => `${(from + index).toString().padStart(5, " ")}\t${line}`,
    )
    .join("\n");

/** Line-numbered output pasted back as content — a write that would corrupt the file. */
export const looksLineNumbered = (content: string): boolean => {
  const lines = content.split("\n").slice(0, 5);
  const numbered = lines.filter((line) => /^\s*\d+\t/.test(line)).length;
  return lines.length > 1 && numbered >= Math.min(lines.length, 3);
};

export const isEntry = (path: string): boolean => path === PAGE_ENTRY_FILE;

/**
 * Every path a project may hold — the code grammar, the entry, AND `page.json`.
 *
 * `page.json` has to be listed here explicitly because it is deliberately
 * absent from `PAGE_FILE_PATH_RE`: that regex validates `code.files`, which is
 * what reaches the compiler, and the manifest is not code. Enforcing the code
 * grammar on a WRITE therefore refused the one file that declares a page's
 * datasets — measured on 2026-09-04, where the builder answered the refusal by
 * putting four dataset configs in `lib/dealsHelper.ts` instead. They compiled,
 * they read as configuration, and the server ran none of them: the page shipped
 * empty over a collection of 24 records, and its summary called it working.
 */
export const isProjectPath = (path: string): boolean =>
  path === PAGE_ENTRY_FILE ||
  path === PAGE_JSON_FILE ||
  PAGE_FILE_PATH_RE.test(path);
