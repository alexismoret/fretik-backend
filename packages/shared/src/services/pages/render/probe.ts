/**
 * The probe — a script injected into the page frame FOR RENDERING ONLY (never
 * in the srcdoc the app serves to a user).
 *
 * Why it exists: the page runs in an opaque origin, so the harness parent
 * cannot read its DOM by construction (that is the whole security model, and
 * it stays intact). But the parent is the only side that can talk to the
 * browser. So the probe lives INSIDE the frame, where the DOM is readable, and
 * answers questions over postMessage — the same channel the page's own bridge
 * already uses. The page's code, the real SDK and the real CSP are untouched.
 *
 * It answers the two questions a screenshot cannot ask, both of which caught
 * real shipped bugs: "did clicking this do anything" and "did the overlay it
 * opened contain anything".
 */

/**
 * An overlay that opens with NO content element and barely any text is the
 * empty-overlay bug: a title bar and a couple of buttons, nothing inside.
 * Measured on the real defect: an empty compose modal reports 0 content
 * elements and 34 characters (its own title plus "Annuler"/"Envoyer").
 */
export const EMPTY_OVERLAY_CHARS = 80;

/** Clicking more than this adds latency without adding coverage. */
export const MAX_INTERACTIONS = 10;

export const buildProbeScript = (): string => `
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';
  const overlays = () => [...document.querySelectorAll(OVERLAY_SELECTOR)].filter(visible);
  const overlayText = () => overlays().map((o) => (o.innerText || '').trim()).join(' ');

  /**
   * Things that constitute CONTENT inside an overlay, as opposed to its own
   * chrome. Counting elements rather than characters is deliberate: a compose
   * form made of placeholder-only inputs contributes nothing to innerText, so
   * a character count would call a perfectly good form empty. Buttons are
   * excluded — a title and two buttons is exactly the empty case.
   */
  const OVERLAY_CONTENT = 'input,textarea,select,table,img,canvas,p,li,h1,h2,h3,h4,h5,h6,[role="row"],[role="option"],[role="menuitem"]';

  /** The overlay's OWN title and description, named by ARIA. Excluding them
   * is what separates "a panel with content" from "a title and nothing else". */
  const chromeOf = (overlay) => {
    const ids = [overlay.getAttribute('aria-labelledby'), overlay.getAttribute('aria-describedby')]
      .filter(Boolean)
      .flatMap((value) => value.split(/\\s+/));
    return ids.map((id) => document.getElementById(id)).filter(Boolean);
  };

  const overlayContentCount = () =>
    overlays().reduce((total, overlay) => {
      const chrome = chromeOf(overlay);
      const content = [...overlay.querySelectorAll(OVERLAY_CONTENT)].filter(
        (el) => !chrome.some((root) => root === el || root.contains(el)),
      );
      return total + content.length;
    }, 0);

  const label = (el, kind) => {
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    return kind + ' "' + (text.length > 48 ? text.slice(0, 48) + '…' : text || '(no text)') + '"';
  };

  /** Targets that ADVERTISE themselves as clickable, one per family so a
   * 60-row table costs one click, not sixty. */
  const collect = () => {
    const out = [];
    const seen = new Set();
    const push = (el, kind) => {
      if (!el || seen.has(el) || !visible(el)) return;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
      if (el.closest(OVERLAY_SELECTOR)) return;
      seen.add(el);
      out.push({ el, kind });
    };

    // One representative row per table/list: the "click a row to open it" path.
    for (const container of document.querySelectorAll('table, [role="table"], ul, ol')) {
      const row = container.querySelector('tbody tr, [role="row"]:not(:first-child), li');
      if (row) push(row, 'row');
    }
    for (const el of document.querySelectorAll('button, [role="button"]')) push(el, 'button');
    for (const el of document.querySelectorAll('.cursor-pointer')) push(el, 'pointer');
    return out;
  };

  const fireClick = (el) => {
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(rect.height / 2, 20),
    };
    // Reka/Radix primitives open on pointerdown, plain handlers on click:
    // firing the whole sequence covers both without guessing which is which.
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent('click', init));
  };

  const dismiss = async () => {
    if (overlays().length === 0) return;
    for (const key of ['Escape']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    await sleep(160);
    // Some overlays only close on their own close button.
    if (overlays().length > 0) {
      const close = document.querySelector(OVERLAY_SELECTOR + ' [aria-label*="lose"], ' + OVERLAY_SELECTOR + ' button');
      if (close) { fireClick(close); await sleep(160); }
    }
  };

  /**
   * Content lying outside the viewport that nobody can scroll to.
   *
   * \`scrollWidth > clientWidth\` only catches a page that scrolls SIDEWAYS. The
   * commoner failure is a layout that does not adapt at all inside a shell that
   * clips: the document then reports no overflow while half the screen is cut
   * off. Measured on a real page at 390px — a 510px-wide sidebar, a clipped
   * title and a clipped empty state, all reported as "no overflow".
   *
   * An element inside a horizontally SCROLLABLE ancestor does not count: a wide
   * table scrolling in its own region is the prescribed way to handle width.
   */
  const CLIPPABLE = 'p,li,h1,h2,h3,h4,h5,h6,td,th,button,a,input,textarea,select,img,[role="row"]';
  const scrollableX = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    return false;
  };
  const clippedCount = () => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll(CLIPPABLE)].filter((el) => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.right <= width + 4 && rect.left >= -4) return false;
      return !scrollableX(el);
    }).length;
  };

  const stat = () => {
    const app = document.getElementById('app');
    const doc = document.documentElement;
    return {
      mounted: !!app && app.children.length > 0,
      textLength: (document.body.innerText || '').trim().length,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 2,
      clipped: clippedCount(),
    };
  };

  const interact = async (max) => {
    const results = [];
    const targets = collect().slice(0, max);
    for (const { el, kind } of targets) {
      if (!el.isConnected) continue;
      await dismiss();

      let mutated = false;
      const observer = new MutationObserver(() => { mutated = true; });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

      const before = overlays().length;
      try { fireClick(el); } catch { /* a detached node is not a finding */ }
      await frames();
      await sleep(220);
      observer.disconnect();

      const after = overlays();
      const opened = after.length > before;
      results.push({
        target: label(el, kind),
        kind,
        domChanged: mutated,
        overlayOpened: opened,
        overlayTextLength: opened ? overlayText().length : 0,
        overlayContentCount: opened ? overlayContentCount() : 0,
      });
    }
    await dismiss();
    return results;
  };

  /**
   * Move to the bottom of the page, and say whether that moved anything.
   *
   * Captures are viewport-sized (1280x860), so a page of thirty rows is judged
   * on its first quarter — which is exactly where a table that never bounded
   * its height still looks fine. \`design.md\` already forbids it ("unbounded
   * content gets a bounded viewport") and nothing checked it, because nothing
   * ever looked below the fold. Reporting \`scrolled\` keeps a page that fits
   * from paying for a second, identical capture.
   */
  const scrollEnd = () => {
    const el = document.scrollingElement || document.documentElement;
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return { scrolled: el.scrollTop > before + 8 };
  };

  const scrollStart = () => {
    const el = document.scrollingElement || document.documentElement;
    el.scrollTop = 0;
    return { scrolled: false };
  };

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.__probe__ !== 'run') return;
    let value = null;
    try {
      if (data.cmd === 'stat') value = stat();
      else if (data.cmd === 'scrollEnd') value = scrollEnd();
      else if (data.cmd === 'scrollStart') value = scrollStart();
      else if (data.cmd === 'interact') value = await interact(${MAX_INTERACTIONS.toString()});
    } catch (error) {
      value = { error: String(error && error.message ? error.message : error) };
    }
    parent.postMessage({ __probe__: 'result', id: data.id, value }, '*');
  });
})();
`;
