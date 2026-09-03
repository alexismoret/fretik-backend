import { PAGE_ENTRY_FILE } from "@fretik/shared/schemas/pages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { getPage } from "@fretik/shared/services/pages/retrieve";
import type { PageRequester } from "@fretik/shared/services/pages/visibility";
import { getRuntimeContext } from "../../agents/shared/runtime-context";
import { renderProjectManifest } from "../../services/page-project/manifest";
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
 * The working copy is keyed by the RUN — a builder dispatch has its own trace
 * id — so two builds in one turn cannot write over each other, and a tool that
 * finds no copy for a page that already exists seeds one from what is stored.
 * That is what makes a repair start from the real page rather than from
 * nothing.
 */

export interface PageProjectContext {
  teamId: string;
  userId: string | null;
  organizationId: string;
  conversationId: string | undefined;
  /**
   * The RUN — one builder dispatch. Keys the working copy, so two builds in
   * one turn keep their files apart.
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
