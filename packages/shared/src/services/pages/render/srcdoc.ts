import type { PageCompiled } from "../../../schemas/pages";
import { buildProbeScript } from "./probe";

/**
 * Server-side twin of `app/app/app/utils/pageSrcdoc.ts`.
 *
 * DELIBERATE DUPLICATE, not a shared module: the frontend is a separate repo
 * that does not depend on the backend workspaces, so importing this from there
 * would create a cross-repo dependency for a pure 60-line string builder. The
 * two must stay in step — the CSP, the import map and the escaping are the
 * page's security boundary. Change one, change the other.
 *
 * The ONLY difference is `probe`, which the app never sets: an extra inline
 * script that lets the renderer ask the frame questions its opaque origin
 * forbids the parent from answering itself.
 */

const escapeScript = (code: string): string =>
  code.replaceAll("</script", "<\\/script");
const escapeStyle = (css: string): string =>
  css.replaceAll("</style", "<\\/style");

export const PAGE_IFRAME_SANDBOX = "allow-scripts allow-forms";

export const buildPageSrcdoc = (params: {
  compiled: PageCompiled;
  nonce: string;
  parentOrigin: string;
  /** Renderer only. Never true for a document a user's browser will load. */
  probe?: boolean;
}): string => {
  const assetsBase = `${params.parentOrigin}/page-runtime/${params.compiled.runtimeVersion}`;
  const csp = [
    `default-src 'none'`,
    `script-src 'unsafe-inline' ${params.parentOrigin}`,
    `style-src 'unsafe-inline' ${params.parentOrigin}`,
    `img-src ${params.parentOrigin} https: data: blob:`,
    `font-src ${params.parentOrigin}`,
    `connect-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
    `object-src 'none'`,
  ].join("; ");

  const importMap = JSON.stringify({
    imports: {
      vue: `${assetsBase}/vue.js`,
      "vue-router": `${assetsBase}/router.js`,
      "@nuxt/ui": `${assetsBase}/ui.js`,
      "chart.js": `${assetsBase}/chart.js`,
      "chart.js/auto": `${assetsBase}/chart.js`,
      "@vueuse/core": `${assetsBase}/vueuse.js`,
      "@internationalized/date": `${assetsBase}/date.js`,
      "@atlaskit/pragmatic-drag-and-drop/element/adapter": `${assetsBase}/dnd.js`,
      "@atlaskit/pragmatic-drag-and-drop/combine": `${assetsBase}/dnd.js`,
      "@atlaskit/pragmatic-drag-and-drop/reorder": `${assetsBase}/dnd.js`,
      "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge": `${assetsBase}/dnd.js`,
      "#fretik/sdk": `${assetsBase}/sdk.js`,
    },
  });

  const boot = JSON.stringify({
    nonce: params.nonce,
    parentOrigin: params.parentOrigin,
  });

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<script>window.__FRETIK__=${escapeScript(boot)}</script>`,
    `<script type="importmap">${escapeScript(importMap)}</script>`,
    `<link rel="stylesheet" href="${assetsBase}/runtime.css">`,
    `<style>${escapeStyle(params.compiled.css)}</style>`,
    "</head>",
    "<body>",
    '<div id="app" class="isolate"></div>',
    ...(params.probe === true
      ? [`<script>${escapeScript(buildProbeScript())}</script>`]
      : []),
    `<script type="module">${escapeScript(params.compiled.js)}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
};
