import { PAGE_ENTRY_FILE } from "../../../schemas/pages";
import { matchesPageRoute, type PageRoute } from "../routes";
import type { PageLintFinding } from "./types";
import { staticProp, templateElements } from "./walk-template";

/**
 * The two ways a page's own views fail to be reachable.
 *
 * Both are invisible to the compiler — a project whose entry never renders
 * `<RouterView />` links, bundles and mounts perfectly, and shows the shell
 * with a hole where every view should be. The renderer would catch it on the
 * first screenshot, three tool calls and a minute later; this catches it at
 * the write that introduced it, which is where the author still remembers what
 * they meant.
 */

const ROUTER_VIEW_RE = /<(?:RouterView|router-view)\b/;

/**
 * The entry is the shell, and a shell with no outlet shows nothing.
 *
 * `error` rather than `blocking`: the page is not merely worse for it, it is
 * empty below the nav, and every view the author wrote is unreachable. That is
 * the same class of defect as a syntax error, and it deserves the same answer.
 */
export const lintRouterView = (
  path: string,
  source: string,
  routes: readonly PageRoute[],
): PageLintFinding[] => {
  if (path !== PAGE_ENTRY_FILE || routes.length === 0) return [];
  if (ROUTER_VIEW_RE.test(source)) return [];
  return [
    {
      path,
      line: 0,
      rule: "router-view-missing",
      severity: "error",
      message: `this page declares ${routes.length.toString()} view${routes.length === 1 ? "" : "s"} under pages/ but ${PAGE_ENTRY_FILE} never renders <RouterView />, so none of them can appear. ${PAGE_ENTRY_FILE} is the shell — what every view shares — and <RouterView /> is where the current view goes.`,
    },
  ];
};

/**
 * A link written to a view nobody built.
 *
 * `warning`, not blocking: the address may be a typo, but it may equally be a
 * view the author is about to write, and refusing the build between the link
 * and its target would make writing them in that order impossible. What
 * catches the one that survives is the gate, which clicks the link and reads
 * the not-found view off the screen.
 *
 * Static values only. `:to="\`/deal/${row.id}\`"` is the normal way to link a
 * record and cannot be resolved here without running the page.
 */
export const lintRouteLinks = (
  path: string,
  source: string,
  routes: readonly PageRoute[],
): PageLintFinding[] => {
  if (routes.length === 0) return [];
  const findings: PageLintFinding[] = [];
  const seen = new Set<string>();

  for (const element of templateElements(source)) {
    for (const name of ["to", "href"]) {
      const value = staticProp(element, name);
      if (value === null) continue;
      if (!value.startsWith("/") || value.startsWith("//")) continue;
      const target = value.split("?")[0]?.split("#")[0] ?? value;
      if (matchesPageRoute(routes, target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      findings.push({
        path,
        line: element.line,
        rule: "route-link-unknown",
        severity: "warning",
        message: `<${element.tag} ${name}="${value}"> points at "${target}", which no file under pages/ answers. This page's views are: ${routes.map((route) => route.path).join(", ")}. Add the file for it, or point the link at a view that exists — a link to an address nothing declares shows the reader an empty view.`,
      });
    }
  }
  return findings;
};
