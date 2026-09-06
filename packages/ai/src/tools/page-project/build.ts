import { tool } from "ai";
import { z } from "zod";
import { buildPageProject } from "../../services/page-project/build";
import { componentsUsed } from "../../services/page-project/manifest";
import type { PageProjectState } from "../../services/page-project/store";
import { recordPageWrite } from "../../services/page-project/write-stats";
import {
  listComponentsRead,
  readPageReviewVerdict,
} from "../../services/page-review/page-session-store";
import { MAX_COMPONENT_DOCS, listContractHeavy } from "../page-component-docs";
import {
  loadPageProjectContext,
  manifestOf,
  type PageProjectContext,
} from "./context";

/**
 * Compile every file and, if it builds, save it as the page.
 *
 * The work is in `services/page-project/build.ts` — this is the door the agent
 * knocks on. What the tool adds is what the agent needs on top of the outcome:
 * the project's shape, and the one sentence saying what to do next.
 */

/**
 * Name the components this page places by hand without ever having read their
 * API. Not a refusal — the compiler stays the only gate — but the omission
 * stops being invisible, and the review can be read against it.
 *
 * Documenting the rule did not work: two shipped pages skipped `pageDocs` and
 * both failed the same way, on a slot placed by intuition. Nuxt UI does not
 * complain — it renders something plausible — so nothing downstream caught it.
 */
const unreadComponentWarnings = async (
  files: Record<string, string>,
  conversationId: string | undefined,
): Promise<string[]> => {
  // No conversation, nothing to have remembered: warning about everything
  // would only teach the agent that this channel is noise.
  if (conversationId === undefined) return [];
  const used = new Set(
    Object.entries(files)
      .filter(([path]) => path.endsWith(".vue"))
      .flatMap(([, content]) => componentsUsed(content)),
  );
  const heavy = await listContractHeavy([...used]);
  if (heavy.length === 0) return [];
  const read = await listComponentsRead(conversationId);
  const unread = heavy.filter((name) => !read.has(name));
  if (unread.length === 0) return [];
  return [
    `Placed without reading their API: ${unread.join(", ")}. These components expect their parts in NAMED slots — put content in the wrong one and it renders somewhere else, or not at all, with no error. pageDocs { components: [${unread
      .slice(0, MAX_COMPONENT_DOCS)
      .map((name) => `"${name}"`)
      .join(", ")}] } and check each one you used.`,
  ];
};

/** A red build, in the shape the agent already knows how to act on. */
export interface FailedBuild {
  ok: false;
  errors: string[];
  manifest: string;
  next: string;
}

/** A green build: saved, with the project it published. */
export interface GreenBuild {
  ok: true;
  pageId: string;
  url: string;
  manifest: string;
  warnings?: string[];
  unchanged: boolean;
  state: PageProjectState;
}

/**
 * Compile and save the working copy, from an already-loaded project context.
 *
 * Shared with `pageReview`, which builds a dirty copy itself rather than
 * refusing: the refusal cost a full model step to say "run the tool you were
 * always going to run next", once per round of a loop that runs up to seven
 * times. A step is a step whatever it produces — the whole conversation is
 * replayed either way — so the cheapest round is the one with fewer of them.
 *
 * A red build returns the SAME shape from either door, so the fix that follows
 * is the same fix.
 */
export const buildFromContext = async (
  project: PageProjectContext,
): Promise<FailedBuild | GreenBuild> => {
  const result = await buildPageProject({
    state: project.state,
    teamId: project.teamId,
    organizationId: project.organizationId,
    userId: project.userId,
    conversationId: project.conversationId,
    requester: project.requester,
    // The TURN, not the run: the builder's own scope is a child of it, and
    // Langfuse prices the trace. See `PageVersionMeta.traceId`.
    traceId: project.reviewScope,
  });

  if (!result.ok) {
    // The files stay exactly as they are: a refused build costs the build,
    // never the work.
    return {
      ok: false,
      errors: result.errors,
      manifest: manifestOf(project.state),
      next: "Fix the named lines — pageEdit the file each one points at, or pageWrite it whole — then build again. Nothing was saved and nothing was lost.",
    };
  }

  await project.save(result.state);
  // One event per green build, so the writes above it can be counted per
  // page rather than per run: `charsEmitted: 0` because a build emits
  // nothing — what it records is the project it published.
  const files = Object.values(result.state.files);
  recordPageWrite({
    mode: "build",
    path: result.pageId,
    linesChanged: 0,
    linesTotal: files.reduce(
      (total, file) => total + file.split("\n").length,
      0,
    ),
    charsEmitted: 0,
    ratio: 0,
  });
  const warnings = [
    ...result.warnings,
    ...(result.unchanged
      ? []
      : await unreadComponentWarnings(
          result.state.files,
          project.conversationId,
        )),
  ];
  return {
    ok: true,
    pageId: result.pageId,
    url: result.url,
    manifest: manifestOf(result.state),
    ...(warnings.length > 0 ? { warnings } : {}),
    unchanged: result.unchanged,
    state: result.state,
  };
};

/** The fields of a stored verdict worth repeating — the judgement, not the prose. */
const VERDICT_FIELDS = [
  "gate",
  "verdict",
  "score",
  "iteration",
  "phase",
] as const;

/**
 * The verdict already recorded for exactly these bytes, if there is one.
 *
 * `builtHash` and a verdict's `sourceHash` are both a sha256 over
 * `path\0content\0` for every file of the project, so they are directly
 * comparable — a match means this version is the one that was judged.
 */
const standingVerdict = async (
  scope: string | undefined,
  built: GreenBuild,
): Promise<{ review: Record<string, unknown>; next: string } | undefined> => {
  const stored = await readPageReviewVerdict(scope, built.pageId);
  if (stored === null || stored.sourceHash !== built.state.builtHash) {
    return undefined;
  }
  const review: Record<string, unknown> = {};
  for (const field of VERDICT_FIELDS) {
    const value = stored.result[field];
    if (value !== undefined) review[field] = value;
  }
  const next = stored.result["next"];
  return {
    review,
    next:
      typeof next === "string"
        ? next
        : "Nothing changed since the last build, and this version already has its verdict.",
  };
};

export const createPageBuildTool = () =>
  tool({
    description:
      "Compile every file and, if it builds, save it as the page. This is the only step that publishes anything: writes and edits before it are private to this run, and a build that fails leaves them exactly as they are. Returns the errors as `file:line`, plus the project's manifest.",
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const project = await loadPageProjectContext(options);
      const built = await buildFromContext(project);
      if (!built.ok) return built;
      // A build of files nobody changed answers nothing, and the answer cost a
      // full model step — every step replays the whole conversation, whatever
      // it produces. If this exact version already has a verdict, hand that
      // back instead of asking for another review to fetch it.
      const standing = built.unchanged
        ? await standingVerdict(project.reviewScope, built)
        : undefined;
      return {
        ok: true,
        pageId: built.pageId,
        url: built.url,
        manifest: built.manifest,
        ...(built.warnings !== undefined ? { warnings: built.warnings } : {}),
        ...(standing !== undefined ? { review: standing.review } : {}),
        next:
          standing?.next ??
          (built.unchanged
            ? "Nothing changed since the last build, and this version has not been reviewed: pageReview it."
            : "The page is saved and live at that url. Review it before handing it over."),
      };
    },
  });
