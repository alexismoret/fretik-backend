import { eachPageFile } from "../../schemas/pages";

/**
 * The views a page declares, derived from where its files sit.
 *
 * A page may be a mini-app: a list on one view, a record on another, each with
 * an address a person can send to a colleague. What decides the address is the
 * FILE PATH, not a declaration in `page.json` — the convention Nuxt taught
 * every model that writes Vue, and the one shape that cannot drift, because a
 * route with no file and a file with no route are both unrepresentable.
 *
 * The router itself runs on memory history inside the frame (`sdk/router.ts`
 * says why), and the host mirrors its position into the real URL. So these
 * paths are what a shared link ends in, and what `useRoute().params` hands a
 * view.
 */

export interface PageRoute {
  /** vue-router path: `/`, `/activity`, `/activity/:id`. */
  path: string;
  /** Stable name, Nuxt-shaped: `index`, `activity`, `activity-id`. */
  name: string;
  /** The project file this route mounts. */
  file: string;
  /** Dynamic segments, in order. Empty for a static route. */
  params: string[];
}

export type PageRoutesResult =
  { ok: true; routes: PageRoute[] } | { ok: false; errors: string[] };

const PAGES_DIR = "pages/";
const PARAM_RE = /^\[([a-z][a-zA-Z0-9]*)\]$/;

/** `pages/activity/[id].vue` → `["activity", "[id]"]`. */
const segmentsOf = (file: string): string[] =>
  file.slice(PAGES_DIR.length, -".vue".length).split("/");

/**
 * Where one file answers.
 *
 * `index` is the segment that disappears — it names the directory it sits in,
 * which is what makes `pages/index.vue` the root and `pages/activity/index.vue`
 * the same address as `pages/activity.vue` (and therefore a conflict, caught
 * below rather than silently resolved by order).
 */
const routeOf = (file: string): PageRoute => {
  const segments = segmentsOf(file);
  const addressed = segments.filter(
    (segment, index) => !(segment === "index" && index === segments.length - 1),
  );
  const params: string[] = [];
  const parts = addressed.map((segment) => {
    const param = PARAM_RE.exec(segment);
    if (param?.[1] === undefined) return segment;
    params.push(param[1]);
    return `:${param[1]}`;
  });
  return {
    path: `/${parts.join("/")}`,
    name:
      addressed.length === 0
        ? "index"
        : addressed.join("-").replaceAll(/[[\]]/g, ""),
    file,
    params,
  };
};

/** Does this project declare views of its own? */
export const projectHasRoutes = (paths: readonly string[]): boolean =>
  paths.some((path) => path.startsWith(PAGES_DIR));

/**
 * Every route the project declares, or what stops it from having any.
 *
 * The two errors are the two ways a `pages/` directory can be incoherent, and
 * both are refused rather than repaired: a page whose root view is missing
 * renders the not-found view on arrival, and two files for one address is a
 * question about intent that only the author can answer.
 *
 * Ordered longest-static-prefix first is NOT needed — vue-router ranks its own
 * records — so the order here is the readable one: the root, then alphabetical.
 */
export const derivePageRoutes = (
  paths: readonly string[],
): PageRoutesResult => {
  const files = [...paths].filter((path) => path.startsWith(PAGES_DIR)).sort();
  if (files.length === 0) return { ok: true, routes: [] };

  const routes = files.map(routeOf);
  const errors: string[] = [];

  const byPath = new Map<string, string[]>();
  for (const route of routes) {
    byPath.set(route.path, [...(byPath.get(route.path) ?? []), route.file]);
  }
  for (const [path, owners] of byPath) {
    if (owners.length > 1) {
      errors.push(
        `${owners.join(" and ")} both answer at "${path}" — keep one of them.`,
      );
    }
  }

  if (!byPath.has("/")) {
    errors.push(
      `pages/ has no index.vue, so the page has nothing to show when it opens — add pages/index.vue.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    routes: routes.sort((a, b) =>
      a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path),
    ),
  };
};

/** Same, from a page's code. */
export const derivePageRoutesOfCode = (code: {
  source: string;
  files?: Record<string, string> | undefined;
}): PageRoutesResult =>
  derivePageRoutes(eachPageFile(code).map(([path]) => path));

/** `/deal/:id` → matches `/deal/7`, not `/deal/7/notes`. */
const matcher = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split("/")
      .map((segment) =>
        segment.startsWith(":")
          ? "[^/]+"
          : segment.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/")}$`,
  );

/**
 * Does any declared view answer at this address?
 *
 * The question two callers ask for different reasons — a lint asking whether a
 * link points anywhere, and the renderer asking whether the view it just
 * landed on is one of the page's own or the not-found placeholder — so the
 * pattern lives here rather than being written twice with two subtly
 * different escapes. The query string is not part of the address.
 */
export const matchesPageRoute = (
  routes: readonly PageRoute[],
  fullPath: string,
): boolean => {
  const path = fullPath.split("?")[0]?.split("#")[0] ?? fullPath;
  return routes.some((route) => matcher(route.path).test(path));
};

/**
 * `/ → pages/index.vue · /activity/:id → pages/activity/[id].vue`
 *
 * One line, because it goes in the manifest the builder and the critic both
 * read, where every other line is one file.
 */
export const formatRouteTable = (result: PageRoutesResult): string =>
  result.ok
    ? result.routes.map((route) => `${route.path} → ${route.file}`).join(" · ")
    : `(invalid — ${result.errors.join(" ")})`;
