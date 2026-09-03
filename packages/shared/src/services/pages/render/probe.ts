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

  /**
   * The open overlay, serialised as STRUCTURE rather than pixels.
   *
   * The critic never sees an overlay: the click pass opens each one for about
   * 220ms and dismisses it before the next capture, so a slideover that opens
   * empty or a form with no way to submit reaches nobody. A screenshot per
   * overlay was the obvious fix and the wrong one — five more images on every
   * round, for panels that are mostly text. This is the same tree, in text,
   * for roughly a tenth of the cost, and the probe already runs inside the
   * frame with the overlay open, so it costs no extra capture at all.
   */
  const SNAPSHOT_TAGS = 'h1,h2,h3,h4,h5,h6,p,li,td,th,button,a,input,textarea,select,img,label,summary,dt,dd,[role]';
  const SNAPSHOT_LIMIT = 1200;

  const nodeLine = (el, depth) => {
    const tag = el.tagName.toLowerCase();
    // OWN text only — a wrapper would otherwise repeat everything under it.
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.nodeValue;
    text = text.trim().replace(/\\s+/g, ' ');
    if (!text) text = (el.getAttribute('aria-label') || '').trim();
    let extra = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const placeholder = el.getAttribute('placeholder') || '';
      const value = el.value == null ? '' : String(el.value).trim();
      extra = ' [' + (el.getAttribute('type') || tag)
        + (placeholder ? ' placeholder="' + placeholder + '"' : '')
        + (value ? ' value="' + value.slice(0, 24) + '"' : '') + ']';
    } else if (tag === 'img') {
      extra = ' [img alt="' + (el.getAttribute('alt') || '') + '"]';
    }
    if (!text && !extra) return null;
    const role = el.getAttribute('role');
    const name = role && role !== tag ? role : tag;
    return '  '.repeat(depth > 6 ? 6 : depth) + name
      + (text ? ' ' + (text.length > 60 ? text.slice(0, 60) + '…' : text) : '') + extra;
  };

  const snapshotOverlay = (overlay) => {
    const lines = [];
    const walk = (el, depth) => {
      for (const child of el.children) {
        if (!visible(child)) continue;
        const line = child.matches(SNAPSHOT_TAGS) ? nodeLine(child, depth) : null;
        if (line) lines.push(line);
        walk(child, line ? depth + 1 : depth);
      }
    };
    walk(overlay, 0);
    const out = lines.join('\\n');
    return out.length > SNAPSHOT_LIMIT ? out.slice(0, SNAPSHOT_LIMIT) + '\\n… (truncated)' : out;
  };

  const label = (el, kind) => {
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    return kind + ' "' + (text.length > 48 ? text.slice(0, 48) + '…' : text || '(no text)') + '"';
  };

  /**
   * A control ALREADY in the state a click would put it in — the selected tab,
   * the active segment of a group, the checked toggle.
   *
   * Clicking one changes nothing, by design, and the probe cannot tell that
   * from a control that does not work: two shipped pages were blocked on
   * "clicking ₫ VND changes nothing" and "clicking Vue d'ensemble changes
   * nothing", both about the segment that was already showing.
   *
   * \`aria-expanded\` and \`data-state="open"\` are deliberately NOT here: an open
   * disclosure closes when clicked, which is a real change and worth measuring.
   */
  const ACTIVE_STATES = ['active', 'checked', 'on', 'selected'];
  const isActive = (el) => {
    for (const attr of ['aria-selected', 'aria-pressed', 'aria-checked']) {
      if (el.getAttribute(attr) === 'true') return true;
    }
    const current = el.getAttribute('aria-current');
    if (current !== null && current !== 'false') return true;
    return ACTIVE_STATES.indexOf(el.getAttribute('data-state')) !== -1;
  };

  /** Targets that ADVERTISE themselves as clickable, one per family so a
   * 60-row table costs one click, not sixty. */
  const collect = () => {
    const out = [];
    const seen = new Set();
    let skippedActive = 0;
    const push = (el, kind) => {
      if (!el || seen.has(el) || !visible(el)) return;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
      if (el.closest(OVERLAY_SELECTOR)) return;
      seen.add(el);
      if (isActive(el)) { skippedActive += 1; return; }
      out.push({ el, kind });
    };

    // One representative row per table/list: the "click a row to open it" path.
    for (const container of document.querySelectorAll('table, [role="table"], ul, ol')) {
      const row = container.querySelector('tbody tr, [role="row"]:not(:first-child), li');
      if (row) push(row, 'row');
    }
    for (const el of document.querySelectorAll('button, [role="button"]')) push(el, 'button');
    for (const el of document.querySelectorAll('.cursor-pointer')) push(el, 'pointer');
    return { targets: out, skippedActive };
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

  const draggables = () => [...document.querySelectorAll('[draggable="true"]')].filter(visible);

  const stat = () => {
    const app = document.getElementById('app');
    const doc = document.documentElement;
    return {
      mounted: !!app && app.children.length > 0,
      textLength: (document.body.innerText || '').trim().length,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 2,
      clipped: clippedCount(),
      draggables: draggables().length,
    };
  };

  /**
   * One synthetic drag, end to end, plus the one count that catches the bug a
   * drag cannot: elements that stop being draggable after a re-render.
   *
   * The click pass never drags, so a board that is beautiful and inert passes
   * every gate — the shipped failure mode (measured 2026-08-21: 24 cards
   * draggable at mount, 0 after the first re-render, no drop ever fired). The
   * event sequence here is the one Pragmatic's own testing guidance simulates:
   * dragstart on the source arms the library, dragenter/dragover on the target
   * exercise its drop registration (a live target calls preventDefault on the
   * cancelable dragover — dispatchEvent returning false IS the acceptance
   * signal), drop and dragend close it out. The recount at the end is the
   * teardown-bug detector: dragenter handlers mutate hover state on typical
   * boards, that re-render is exactly what killed the registrations, and a
   * page with no drag wiring at all cannot re-render from these events — so a
   * collapse to zero cannot be produced by a static page or a view switch.
   */
  const dragCheck = async () => {
    const items = draggables();
    const before = items.length;
    const idle = { draggables: before, dragoverAccepted: false, dropHandled: false, domChanged: false, draggablesAfter: before };
    if (before === 0) return idle;
    const source = items[0];
    const apart = (el) =>
      el !== source &&
      !(el.parentElement && el.parentElement.contains(source)) &&
      !(source.parentElement && source.parentElement.contains(el));
    // Prefer a target outside the source's own container — a card in another
    // lane — so the drag crosses a real drop boundary instead of hovering its
    // own siblings.
    const target = items.find(apart) || items[items.length - 1];
    let mutated = false;
    const observer = new MutationObserver(() => { mutated = true; });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const dt = new DataTransfer();
    const fire = (type, el) => {
      const rect = el.getBoundingClientRect();
      return el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
    };
    try {
      fire('dragstart', source);
      await frames();
      fire('dragenter', target);
      const dragoverAccepted = !fire('dragover', target);
      await frames();
      await sleep(160);
      const dropHandled = !fire('drop', target);
      fire('dragend', source);
      await frames();
      await sleep(160);
      observer.disconnect();
      return {
        draggables: before,
        dragoverAccepted,
        dropHandled,
        domChanged: mutated,
        draggablesAfter: draggables().length,
      };
    } catch (error) {
      observer.disconnect();
      return { ...idle, error: String(error && error.message ? error.message : error) };
    }
  };

  /**
   * The click pass, driven ONE target at a time.
   *
   * Stepped rather than looped because the driver — the only side that can
   * reach the browser — has to screenshot an overlay while it is still open,
   * and a single call that clicks everything dismisses each panel before
   * anyone outside the frame can look at it. Each step dismisses what the
   * previous one opened, so the ordering the whole-loop version guaranteed is
   * unchanged; the panel simply stays up across the return.
   */
  let session = null;

  const interactBegin = (max) => {
    // Snapshots are capped independently of the click budget: a page whose
    // every row opens the same slideover would otherwise send the same tree
    // five times, and the fifth copy tells the critic nothing the first did not.
    const found = collect();
    session = { targets: found.targets.slice(0, max), index: 0, results: [], snapshotsLeft: 4 };
    return { count: session.targets.length, skippedActive: found.skippedActive };
  };

  const interactStep = async () => {
    if (!session) return { done: true };
    // Skips detached nodes here rather than returning a hole: the driver
    // counts steps, and a silent \`continue\` in a stepped protocol ends the
    // pass early.
    while (session.index < session.targets.length && !session.targets[session.index].el.isConnected) {
      session.index += 1;
    }
    if (session.index >= session.targets.length) return { done: true };
    const { el, kind } = session.targets[session.index];
    session.index += 1;

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
    // Serialised HERE, with the overlay still open — the next step dismisses
    // it, and nothing downstream can look at it again.
    const snapshot = opened && session.snapshotsLeft > 0
      ? snapshotOverlay(after[after.length - 1])
      : '';
    if (snapshot) session.snapshotsLeft -= 1;
    const result = {
      target: label(el, kind),
      kind,
      domChanged: mutated,
      overlayOpened: opened,
      overlayTextLength: opened ? overlayText().length : 0,
      overlayContentCount: opened ? overlayContentCount() : 0,
      overlaySnapshot: snapshot,
    };
    session.results.push(result);
    return { done: false, ...result };
  };

  const interactEnd = async () => {
    await dismiss();
    const results = session ? session.results : [];
    session = null;
    return results;
  };

  const interact = async (max) => {
    interactBegin(max);
    for (;;) {
      const step = await interactStep();
      if (step.done) break;
    }
    return interactEnd();
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

  /**
   * How tall the page is against how much of it fits.
   *
   * Read WITHOUT scrolling, because the answer decides how many captures the
   * page is worth: two screens is a top and a bottom, five is a page whose
   * whole middle nobody has ever looked at.
   */
  const geometry = () => {
    const el = document.scrollingElement || document.documentElement;
    return {
      scrollHeight: el.scrollHeight,
      viewport: el.clientHeight || window.innerHeight || 0,
    };
  };

  /** Move to a fraction of the scrollable range — 0 is the top, 1 the end. */
  const scrollTo = (fraction) => {
    const el = document.scrollingElement || document.documentElement;
    const range = el.scrollHeight - (el.clientHeight || 0);
    const ratio = typeof fraction === 'number' ? fraction : 0.5;
    el.scrollTop = range > 0 ? range * ratio : 0;
    return { scrolled: el.scrollTop > 8 };
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
      else if (data.cmd === 'geometry') value = geometry();
      else if (data.cmd === 'scrollTo') value = scrollTo(data.arg);
      else if (data.cmd === 'scrollEnd') value = scrollEnd();
      else if (data.cmd === 'scrollStart') value = scrollStart();
      else if (data.cmd === 'dragCheck') value = await dragCheck();
      else if (data.cmd === 'interact') value = await interact(${MAX_INTERACTIONS.toString()});
      else if (data.cmd === 'interactBegin') value = interactBegin(${MAX_INTERACTIONS.toString()});
      else if (data.cmd === 'interactStep') value = await interactStep();
      else if (data.cmd === 'interactEnd') value = await interactEnd();
    } catch (error) {
      value = { error: String(error && error.message ? error.message : error) };
    }
    parent.postMessage({ __probe__: 'result', id: data.id, value }, '*');
  });
})();
`;
