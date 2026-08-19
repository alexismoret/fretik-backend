import type { PageDataResponse } from "../../../schemas/pages";

/**
 * The harness: the parent document the headless browser loads. It plays the
 * role `PageHost.vue` + `usePageBridge.ts` play in the app, with two
 * differences that make it a REVIEW rig rather than a second renderer:
 *
 * - `data.query` is answered from FIXTURES captured server-side before the
 *   browser started, so a review never depends on live query latency and two
 *   reviews of the same page see the same rows;
 * - `ops.run` resolves `ok` WITHOUT executing anything. A review must be able
 *   to click "Delete" without deleting.
 *
 * Everything else is the production contract: the same sandboxed opaque-origin
 * iframe, the same nonce authentication, the same message shapes.
 */

const escapeScript = (code: string): string =>
  code.replaceAll("</script", "<\\/script");

export interface HarnessParams {
  srcdoc: string;
  nonce: string;
  parentOrigin: string;
  fixtures: PageDataResponse["datasets"];
  pageName: string;
  dark: boolean;
  locale: "en" | "fr";
}

export const buildHarnessHtml = (params: HarnessParams): string => {
  const boot = escapeScript(
    JSON.stringify({
      srcdoc: params.srcdoc,
      nonce: params.nonce,
      parentOrigin: params.parentOrigin,
      fixtures: params.fixtures,
      pageName: params.pageName,
      dark: params.dark,
      locale: params.locale,
    }),
  );

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;height:100%;background:${params.dark ? "#0a0a0a" : "#ffffff"};}
  iframe{border:0;display:block;width:100vw;height:100vh;}
</style>
</head><body>
<iframe id="frame" sandbox="allow-scripts allow-forms"></iframe>
<script>
(() => {
  const BOOT = ${boot};
  const frame = document.getElementById('frame');

  // What the renderer reads back through evaluate().
  window.__STATE__ = { initialized: false, dataAnswered: false, lastMessageAt: 0, pageErrors: [], probe: {} };
  const state = window.__STATE__;

  const hostContext = () => ({
    dark: BOOT.dark,
    accent: null,
    // Left empty on purpose: in the app these carry the LIVE palette so a
    // theme switch reaches the page. Here the runtime bundle's own theme is
    // the truth, and pushing nothing keeps the review reproducible.
    themeVars: {},
    locale: BOOT.locale,
    mode: 'app',
    pageName: BOOT.pageName,
    capabilities: { ops: true },
  });

  const post = (message) => { frame.contentWindow?.postMessage({ frk: 1, ...message }, '*'); };
  const respond = (id, result) => post({ kind: 'res', id, result });

  const answerData = (params) => {
    const ids = params && Array.isArray(params.datasetIds) ? params.datasetIds : null;
    if (!ids) return { datasets: BOOT.fixtures };
    const datasets = {};
    for (const id of ids) if (BOOT.fixtures[id]) datasets[id] = BOOT.fixtures[id];
    return { datasets };
  };

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data) return;

    if (data.__probe__ === 'result') { state.probe[data.id] = data.value; return; }
    if (data.frk !== 1 || data.nonce !== BOOT.nonce) return;
    state.lastMessageAt = Date.now();

    if (data.kind === 'note') {
      if (data.method === 'report.error' && data.params) {
        state.pageErrors.push(String(data.params.message || '').slice(0, 500));
      }
      return;
    }
    if (data.kind !== 'req') return;

    if (data.method === 'initialize') { state.initialized = true; respond(data.id, hostContext()); return; }
    if (data.method === 'data.query') { state.dataAnswered = true; respond(data.id, answerData(data.params)); return; }
    // A review clicks buttons. Operations must answer, and must not run.
    if (data.method === 'ops.run') { respond(data.id, { status: 'ok', message: 'simulated in review' }); return; }
    if (data.method === 'ui.openUrl' || data.method === 'ui.copy') { respond(data.id, { ok: true }); return; }
    post({ kind: 'res', id: data.id, error: { code: 'UNKNOWN_METHOD', message: data.method } });
  });

  let probeSeq = 0;
  window.__probe = (cmd) => {
    const id = ++probeSeq;
    frame.contentWindow?.postMessage({ __probe__: 'run', id, cmd }, '*');
    return id;
  };
  window.__probeResult = (id) => (id in state.probe ? JSON.stringify(state.probe[id]) : null);

  /** Settled = the page handshook, got its data, and went quiet. */
  window.__settled = (quietMs) => {
    if (!state.initialized) return false;
    if (!state.dataAnswered && Object.keys(BOOT.fixtures).length > 0) return false;
    return Date.now() - state.lastMessageAt > quietMs;
  };

  frame.srcdoc = BOOT.srcdoc;
})();
</script>
</body></html>`;
};
