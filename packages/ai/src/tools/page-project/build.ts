import { tool } from "ai";
import { z } from "zod";
import { buildPageProject } from "../../services/page-project/build";
import { recordPageWrite } from "../../services/page-project/write-stats";
import { listComponentsRead } from "../../services/page-review/page-session-store";
import { MAX_COMPONENT_DOCS, listContractHeavy } from "../page-component-docs";
import { loadPageProjectContext, manifestOf } from "./context";

/**
 * Compile every file and, if it builds, save it as the page.
 *
 * The work is in `services/page-project/build.ts` — this is the door the agent
 * knocks on. What the tool adds is what the agent needs on top of the outcome:
 * the project's shape, and the one sentence saying what to do next.
 */

/** `<UModal`, `<u-modal`, `</USlideover>` — every Nuxt UI tag in a template. */
const USED_COMPONENT_RE = /<\/?[uU][A-Z-][A-Za-z0-9-]*/g;

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
      .flatMap(([, content]) => [...content.matchAll(USED_COMPONENT_RE)])
      .map((match) => match[0].replace(/^<\/?/, "")),
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

export const createPageBuildTool = () =>
  tool({
    description:
      "Compile every file and, if it builds, save it as the page. This is the only step that publishes anything: writes and edits before it are private to this run, and a build that fails leaves them exactly as they are. Returns the errors as `file:line`, plus the project's manifest.",
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const project = await loadPageProjectContext(options);
      const result = await buildPageProject({
        state: project.state,
        teamId: project.teamId,
        organizationId: project.organizationId,
        userId: project.userId,
        conversationId: project.conversationId,
        requester: project.requester,
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
        next: result.unchanged
          ? "Nothing changed since the last build. Review it, or change a file first."
          : "The page is saved and live at that url. Review it before handing it over.",
      };
    },
  });
