import { getPage } from "@fretik/shared/services/pages/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import {
  hashProjectFiles,
  projectFiles,
} from "../../services/page-project/store";
import { runPageReview } from "../../services/page-review/run-review";
import { loadPageProjectContext } from "./context";

/**
 * Open the saved page in a real browser and report what using it is like.
 *
 * It reviews what is STORED, never the working copy — a review of files nobody
 * can open would be a review of nothing — so a project with unbuilt changes is
 * sent to build first rather than being judged on its last green version.
 *
 * The loop itself is `services/page-review/run-review.ts`: the mechanical gate
 * first, one critique once it passes, then the gate again.
 */

export const createPageReviewTool = () =>
  tool({
    description:
      'Render the saved page in a browser and report what using it is like: captures at three widths and with the data emptied, a click pass that opens what looks clickable, then a design critique. `blocking` is MEASURED — a control that does nothing, an overlay that opens empty, content cut off, a blank empty state — and it fails a page the critic liked. Fix those, review again; the critic looks once the gate is clean, and `verdict: "ship"` ends the loop.',
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const project = await loadPageProjectContext(options);
      const { state } = project;

      if (state.pageId === undefined) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "There is no saved page to review yet.",
          "pageBuild first: a review renders what is stored, and nothing is stored until a build is green.",
        );
      }
      if (state.builtHash !== hashProjectFiles(projectFiles(state))) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "The files have changed since the last build, so the saved page is not what you wrote.",
          "pageBuild, then review — otherwise you would be judging the previous version.",
        );
      }

      const page = await getPage({
        pageId: state.pageId,
        teamId: project.teamId,
        ...(project.requester !== undefined
          ? { requester: project.requester }
          : {}),
      });

      return await runPageReview({
        page,
        teamId: project.teamId,
        userId: project.userId,
        conversationId: project.conversationId,
        scope: project.reviewScope,
      });
    },
  });
