import { describePageDataContract } from "@fretik/shared/schemas/pages";

/**
 * What a page's code runs INSIDE — the one thing the model cannot know from
 * training: allowed imports, the fretik bridge API, sandbox rules, the styling
 * tokens, and the dataset/variable/operation grammar.
 *
 * Its own module because it has two consumers that must never drift apart:
 * `managePage { action: "get_guide" }` serves it on demand to the main agent,
 * and the page BUILDER receives it in its system prompt — the builder writes a
 * page every time it runs, so paying a tool step to learn its own environment
 * was a step spent on something that never varies.
 *
 * Vue, Nuxt UI, Tailwind and Chart.js are deliberately NOT documented here:
 * the model knows them. Only what is SPECIFIC to this runtime earns space.
 */
export const PAGE_ENVIRONMENT_GUIDE = [
  "## the page",
  'A page is ONE complete Vue SFC: `<template>` + `<script setup lang="ts">` (+ optional `<style scoped>`, plain CSS). The server compiles it on save — a compile error refuses the write and names the lines. It renders inside a sandboxed iframe styled with the app\'s design system.',
  "",
  "## imports",
  "Exactly these, nothing else (the compiler refuses others by name): `vue`, `@nuxt/ui`, `chart.js` (or `chart.js/auto`, pre-registered), `#fretik/sdk`, `@vueuse/core` (curated — `useInfiniteScroll`, `useVirtualList`, `useElementSize`, `useDebounceFn`, `onClickOutside` and their neighbours; storage, fetch and clipboard composables are absent, they cannot work here), `@internationalized/date` (the value type `UCalendar`/`UInputDate`/`UInputTime` take — never a `Date`), and drag-and-drop: `@atlaskit/pragmatic-drag-and-drop/element/adapter`, `/combine`, `/reorder`, `@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge`. One file — no relative imports.",
  "A library with a file under `skills/building-pages/references/libraries/` is one you read BEFORE your first call into it — each exists because that library behaves differently here than its own documentation assumes, and the gap is silent every time. Today: `libraries/drag-and-drop.md` (Pragmatic — mandatory before any `draggable()`).",
  "This cuts both ways for components too: a Nuxt UI component whose published EXAMPLES import beyond the list above cannot be copied from them. `UEditor` is the one that bites — its examples pull `@tiptap/*`, `scule` and `@nuxt/ui/utils/editor`, none of which resolve. Read its API instead and pass plain arrays.",
  "",
  "## components & styling",
  "Every Nuxt UI component is registered globally — use `<UButton>`, `<UTable>`, `<UModal>`, `<UCard>`… without importing. `useToast()`/`useOverlay()` come from `@nuxt/ui`. The app's UApp wrapper is already mounted (toasts, tooltips, overlays work).",
  'Tailwind classes compile from your STATIC class strings — never build a class name at runtime (`:class="`bg-${x}-500`"` yields nothing; toggle between full literal strings instead). App tokens are live: `text-muted`, `text-dimmed`, `text-highlighted`, `bg-default`, `bg-elevated`, `bg-accented`, `border-default`, `primary`/`error`/`success` scales, `dark:` variants, `font-display` (headings), `font-mono`. Icons: `<UIcon name="i-lucide-inbox" />`, the `i-lucide-*` set only, written literally — a name is parsed as `i-<collection>-<icon>`, so `` `i-${x}` `` names a collection that does not exist and renders an empty box. Icons arriving from the data (`fields[].options[].icon`, `targetIcon`) already carry their prefix: pass them to `<UIcon :name>` as they are, NEVER wrap them.',
  "Three contracts the compiler cannot check, each silent when broken. `color` takes only `primary`, `secondary`, `success`, `info`, `warning`, `error`, `neutral` — a Tailwind hue there (`violet`, `teal`) matches no variant, and setting the prop suppresses the default too, so it draws no colour at all; a hue from the DATA goes through `:style` and `var(--color-violet-500)`. `UModal`, `USlideover` and `UDrawer` take content in `#body` — their default slot is the trigger and renders inline on the page. Text written to be read formatted (a message composer, a note) is `UEditor` with `content-type`, never `UTextarea`.",
  "HTML you did not author (an email body, a stored description) will not respect your grid. Markdown goes through `<Markdown>` (the only sanitiser here); anything else sits in a container that bounds it: `max-w-full overflow-x-auto [&_img]:max-w-full [&_table]:max-w-full`. Unbounded it overflows horizontally, which the review counts as blocking. No nested iframe: the CSP declares no `frame-src`.",
  "",
  "## the bridge — `import { fretik } from '#fretik/sdk'`",
  "`await fretik.data.query({ variables?, datasetIds?, queries?, fresh? })` → `{ datasets: { <id>: result } }`. A result is `{ status: 'ok', rows, totalCount?, fields?, page?, pageSize? }` or `{ status: 'forbidden' | 'needs_connection' | 'error' }` — render every status, not just ok. `queries` pages/sorts an `objects` dataset server-side, per dataset: `{ orders: { page: 2, pageSize: 25, sortBy: 'date', sortDir: 'desc' } }`. On an AGGREGATE it takes `sortBy` (a metric name, or `group`/`series`) and `pageSize` (how many groups — top 10 becomes top 20); `page` means nothing there. An `external` dataset IGNORES `queries` — its `args` ARE the provider action's own parameters, so it walks further only if that action offers something to walk with (an offset, a cursor, a page token): bind a variable to it and raise it. Where the action offers none, one call is all there is, and the page says so instead of implying more.",
  "`await fretik.ops.run('<operationId>', { variables? })` → verdict `{ status: 'ok' | 'needs_connection' | 'blocked' | 'cancelled' | 'error', message? }`. The PARENT app shows the confirmation for destructive operations — render the verdict (toast the outcome), never re-confirm.",
  "Every control that promises a write calls it. Faking the effect — a success toast with no `ops.run`, a `setTimeout` for the network, a local edit to server data — is the worst thing a page can ship: it looks right to everyone, you included, and nothing happened. A mail client shipped that way and sent nothing. When an action cannot be wired, leave its control out and say which.",
  "`fretik.ui.openUrl(url)` — plain `<a href>` clicks are routed through the parent automatically. `await fretik.ui.copy(text)` → `{ ok }`: the host writes the clipboard and says NOTHING, so the confirmation is yours — toast on `ok` naming what was copied, and say so when it is false.",
  "`fretik.theme.color('blue' | 'blue-600' | 'primary' | '--any-var')` → the CONCRETE colour. Required for anything drawn on a canvas (Chart.js): canvas cannot resolve `var(--…)`, drops it silently and paints black. CSS `:style` bindings need no such thing.",
  "`fretik.context` — reactive `{ dark, locale, mode, variables }`. Colors/dark-mode are synced automatically; read `dark`/`locale`/`mode` only when the CODE must branch.",
  "`fretik.context.variables` is how a SHARED LINK reopens the page where its sender left it: the host mirrors every variable value you send into the url (`?v.<key>=…`) and hands them back here at startup. Seed each control's ref from it — `const status = ref(fretik.context.variables.status ?? 'all')` — for every variable a control drives. Skipping it is not neutral: the url still fills up, so the link promises a state the page then ignores.",
  "",
  "## sandbox rules",
  "No `fetch`/XHR/WebSocket (CSP blocks all network — data comes from `fretik.data.query` only). No `localStorage`/`sessionStorage` (opaque origin — they throw; keep state in refs). No `window.open` (use `fretik.ui.openUrl`). External images over https are allowed in `<img>`.",
  "",
  "## shape of a page",
  'Load in `onMounted` (one `fretik.data.query()` for everything, then targeted `datasetIds` refetches) and keep rows in refs. HOW the page should then look and behave — layout, component choice, formatting through `fields`, chart wiring, the four dataset states — is `skills/building-pages/`, and `{ action: "components" }` here gives you the real API of any component before you use it.',
].join("\n");

/**
 * The full environment contract: the runtime guide plus the data grammar.
 *
 * Deterministic — it changes only when the schema or this file does — so it is
 * safe to sit in a cached system prefix.
 */
export const renderPageEnvironmentContract = (): string =>
  `${PAGE_ENVIRONMENT_GUIDE}\n\n${describePageDataContract()}`;
