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
  /** The page's own accent, so the review sees the palette the viewer will. */
  accent: string | null;
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
      accent: params.accent,
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
  window.__STATE__ = {
    initialized: false, dataAnswers: 0, lastMessageAt: 0, pageErrors: [], probe: {}, opsRuns: [],
    // Where the page's own router is, what it has acknowledged, and which
    // addresses it could not answer. A page with no views of its own leaves
    // all three at their empty values, which is how the renderer tells the two
    // apart without asking the definition.
    route: '/', routeAcks: [], routeMisses: [], downloads: [],
  };
  const state = window.__STATE__;

  const hostContext = () => ({
    dark: BOOT.dark,
    // The page's real accent: a palette the review never applied is a palette
    // the review cannot judge, and the accent path is exactly where a page has
    // rendered grey in production while every screenshot here looked right.
    accent: BOOT.accent,
    // Left empty on purpose: in the app these carry the LIVE palette so a
    // theme switch reaches the page. Here the runtime bundle's own theme is
    // the truth, and pushing nothing keeps the review reproducible.
    themeVars: {},
    locale: BOOT.locale,
    mode: 'app',
    pageName: BOOT.pageName,
    capabilities: { ops: true },
    // A review always arrives the way a first-time visitor does. The other
    // views are reached afterwards, one capture each, so what the critic sees
    // of view 2 is a page that navigated there — not a page booted into it.
    variables: {},
    route: { fullPath: '/' },
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
        const message = String(data.params.message || '').slice(0, 500);
        // A link to a view nobody built is reported through the same channel
        // as a crash, and it is not one: the page runs, it just leads
        // somewhere empty. Filed separately so the gate can say which link,
        // and so a routing mistake does not read as a page that threw.
        if (data.params.source === 'router') state.routeMisses.push(message);
        else state.pageErrors.push(message);
      }
      if (data.method === 'route.changed' && data.params) {
        state.route = String(data.params.fullPath || '/');
        state.routeAcks.push(state.route);
      }
      return;
    }
    if (data.kind !== 'req') return;

    if (data.method === 'initialize') { state.initialized = true; respond(data.id, hostContext()); return; }
    if (data.method === 'data.query') { state.dataAnswers += 1; respond(data.id, answerData(data.params)); return; }
    // A review clicks buttons. Operations must answer, and must not run.
    // Recorded on the way past: answering 'ok' without executing is what makes
    // a real write indistinguishable from a faked one on screen, so the COUNT
    // of calls is the only evidence left that the controls are wired at all.
    if (data.method === 'ops.run') {
      const opId = data.params && typeof data.params.operationId === 'string' ? data.params.operationId : '?';
      state.opsRuns.push(opId);
      respond(data.id, { status: 'ok', message: 'simulated in review' });
      return;
    }
    if (data.method === 'ui.openUrl' || data.method === 'ui.copy') { respond(data.id, { ok: true }); return; }
    // Answered, never performed — the same rule as ops.run, for the same
    // reason: a review clicks "Export" and must not write to the disk of
    // whatever is running it. The filename is what proves the control is wired.
    if (data.method === 'ui.download') {
      state.downloads.push(String((data.params && data.params.filename) || '?').slice(0, 120));
      respond(data.id, { ok: true });
      return;
    }
    post({ kind: 'res', id: data.id, error: { code: 'UNKNOWN_METHOD', message: data.method } });
  });

  let probeSeq = 0;
  window.__probe = (cmd, arg) => {
    const id = ++probeSeq;
    frame.contentWindow?.postMessage({ __probe__: 'run', id, cmd, arg }, '*');
    return id;
  };
  window.__probeResult = (id) => (id in state.probe ? JSON.stringify(state.probe[id]) : null);

  /** Settled = the page handshook, got its data, and went quiet. */
  window.__settled = (quietMs) => {
    if (!state.initialized) return false;
    if (state.dataAnswers === 0 && Object.keys(BOOT.fixtures).length > 0) return false;
    return Date.now() - state.lastMessageAt > quietMs;
  };

  /**
   * Send the page's router somewhere — what the app's back button and a
   * pasted link do.
   *
   * A note, not a request: the frame acknowledges by navigating and reporting
   * route.changed, which is what __routeSettled waits for. Asking for the
   * address the page is already on is answered by nothing at all, so the
   * caller must not wait on a view it never left.
   */
  window.__route = (fullPath) => {
    post({ kind: 'note', method: 'route.set', params: { fullPath } });
  };

  /** Arrived AND quiet: the view is on screen and has stopped fetching. */
  window.__routeSettled = (fullPath, quietMs) =>
    state.route === fullPath && Date.now() - state.lastMessageAt > quietMs;

  frame.srcdoc = BOOT.srcdoc;
})();
</script>
</body></html>`;
};
