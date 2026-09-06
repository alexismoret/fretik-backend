import { getPage } from "@fretik/shared/services/pages/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import {
  hashProjectFiles,
  projectFiles,
} from "../../services/page-project/store";
import { runPageReview } from "../../services/page-review/run-review";
import { buildFromContext } from "./build";
import { loadPageProjectContext } from "./context";

/**
 * Open the saved page in a real browser and report what using it is like.
 *
 * It reviews what is STORED, never the working copy — a review of files nobody
 * can open would be a review of nothing. So a project with unbuilt changes is
 * BUILT here, rather than refused.
 *
 * The refusal was the older shape and it was expensive in the one place that
 * runs most often. Every `next:` the loop hands back ends with "then review
 * again", and a fix round is edit → build → review: three model steps, of
 * which the build carries no decision at all. A step costs the same whatever
 * it does — the whole conversation is replayed on each one — so refusing cost
 * a full step, once per round, to say "run the tool you were always going to
 * run next". Building here removes it without changing what gets judged: the
 * same `buildPageProject`, the same lints, the same refusal shape when it is
 * red, and nothing renders until a build is green.
 *
 * The loop itself is `services/page-review/run-review.ts`: the mechanical gate
 * first, one critique once it passes, then the gate again.
 */

export const createPageReviewTool = () =>
  tool({
    description:
      'Render the saved page in a browser and report what using it is like: captures at three widths and with the data emptied, a click pass that opens what looks clickable, then a design critique. Builds first when the files changed since the last build, so a fix round is edit, then review. `blocking` is MEASURED — a control that does nothing, an overlay that opens empty, content cut off, a blank empty state — and it fails a page the critic liked. Fix those, review again; the critic looks once the gate is clean, and `verdict: "ship"` ends the loop.',
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const project = await loadPageProjectContext(options);
      let state = project.state;
      let built: string[] | undefined;

      if (Object.keys(state.files).length === 0) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "There is nothing to review — this run has written no files.",
          "Write the page first: a review renders what is stored, and nothing is stored until a build is green.",
        );
      }

      if (
        state.pageId === undefined ||
        state.builtHash !== hashProjectFiles(projectFiles(state))
      ) {
        const result = await buildFromContext(project);
        // Red: the same object `pageBuild` returns, so the fix that follows is
        // the same fix. Nothing rendered, nothing saved, files untouched.
        if (!result.ok) return result;
        state = result.state;
        built = result.warnings;
      }

      if (state.pageId === undefined) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "There is no saved page to review yet.",
          "The build reported no page. Write the files you mean to ship, then review again.",
        );
      }

      const page = await getPage({
        pageId: state.pageId,
        teamId: project.teamId,
        ...(project.requester !== undefined
          ? { requester: project.requester }
          : {}),
      });

      const review = await runPageReview({
        page,
        teamId: project.teamId,
        userId: project.userId,
        conversationId: project.conversationId,
        scope: project.reviewScope,
      });

      // Said only when this call built something: the warnings a build emits
      // are about the files, and they would otherwise be lost between the
      // build nobody asked for and the verdict.
      return built !== undefined && built.length > 0
        ? { ...review, built: { warnings: built } }
        : review;
    },
  });
