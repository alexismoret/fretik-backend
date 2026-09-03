import { createPageBuildTool } from "./build";
import { createPageDocsTool } from "./docs";
import { createPageEditTool } from "./edit";
import { createPageProbeTool } from "./probe";
import { createPageReadTool } from "./read";
import { createPageReviewTool } from "./review";
import { createPageSearchTool } from "./search";
import { createPageWriteTool } from "./write";

/**
 * The page builder's instrument: the tools a coding agent works with, named
 * for what they do to files.
 *
 * They replaced one `managePage` with twelve actions, and the reason is not
 * taste. A tool call is a shape the model has been trained on — read, write,
 * edit, search, build — and an action enum inside one tool is a shape it has
 * not: every call had to carry `action` plus the union of every action's
 * arguments, and the model spent steps rediscovering which combination was
 * legal. What is measured on the other side of that swap is in
 * `page-builder-system-prompt.md`.
 *
 * The parent agent keeps `managePage` — reading, renaming, publishing, small
 * edits to a page someone already built. Authoring is here.
 */
export const buildPageProjectTools = () => ({
  pageRead: createPageReadTool(),
  pageWrite: createPageWriteTool(),
  pageEdit: createPageEditTool(),
  pageSearch: createPageSearchTool(),
  pageBuild: createPageBuildTool(),
  pageProbe: createPageProbeTool(),
  pageReview: createPageReviewTool(),
  pageDocs: createPageDocsTool(),
});
