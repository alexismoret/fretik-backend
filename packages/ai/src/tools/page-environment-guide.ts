import { describePageDataContract } from "@fretik/shared/schemas/pages";

/**
 * What a page's code runs INSIDE — the one thing the model cannot know from
 * training: allowed imports, the fretik bridge API, sandbox rules, the styling
 * tokens, and the dataset/variable/operation grammar.
 *
 * Its own module because it is rendered, never copied: the page BUILDER
 * receives it in its system prompt — it writes a page every time it runs, so
 * paying a tool step to learn its own environment was a step spent on something
 * that never varies — and the skill's own text points at it rather than
 * restating it.
 *
 * Vue, Nuxt UI, Tailwind and Chart.js are deliberately NOT documented here:
 * the model knows them. Only what is SPECIFIC to this runtime earns space.
 */
export const PAGE_ENVIRONMENT_GUIDE = [
  "## the project",
  'A page is a small Vue project, one file per responsibility. `Page.vue` is the entry: layout and loading. `components/<Name>.vue` is a region of it, usable as `<Name>` anywhere in the project with no import — the compiler registers it by filename. `composables/use<Name>.ts` holds shared state, `lib/<name>.ts` pure helpers; both are imported by relative path (`import { usePageData } from "../composables/usePageData"`). `page.json` holds everything that is not code — name, brief, variables, datasets, operations, theme. Every `.vue` file is `<template>` + `<script setup lang="ts">` (+ optional `<style scoped>`, plain CSS).',
  "Growing a page means adding a file, never lengthening one: past ~300 lines a region becomes its own component. The page renders inside a sandboxed iframe styled with the app's design system.",
  "",
  "## imports",
  "Exactly these, nothing else (the compiler refuses others by name): `vue`, `@nuxt/ui`, `chart.js` (or `chart.js/auto`, pre-registered), `#fretik/sdk`, `@vueuse/core` (curated: `useInfiniteScroll`, `useVirtualList`, `useElementSize`, `useDebounceFn`, `onClickOutside` and neighbours — storage, fetch and clipboard composables are absent), `@internationalized/date` (the value type `UCalendar`/`UInputDate`/`UInputTime` take — never a `Date`), and drag-and-drop: `@atlaskit/pragmatic-drag-and-drop/element/adapter`, `/combine`, `/reorder`, `@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge`. A relative path reaches the project's own files; anything else must be on that list.",
  "A library with a file under `skills/building-pages/references/libraries/` behaves differently here than its own documentation assumes, and the gap is silent: read it BEFORE your first call into it. Today that is `libraries/drag-and-drop.md`, before any `draggable()`.",
  "A Nuxt UI component whose published examples import beyond that list cannot be copied from them — `UEditor` is the one that bites (`@tiptap/*`, `scule`, `@nuxt/ui/utils/editor` resolve to nothing): read its API and pass plain arrays.",
  "",
  "## components & styling",
  "Every Nuxt UI component is registered globally — use `<UButton>`, `<UTable>`, `<UModal>`, `<UCard>`… without importing. `useToast()`/`useOverlay()` come from `@nuxt/ui`. The app's UApp wrapper is already mounted (toasts, tooltips, overlays work).",
  'Tailwind classes compile from your STATIC class strings — never build a class name at runtime (`:class="`bg-${x}-500`"` yields nothing; toggle between full literal strings instead). App tokens are live: `text-muted`, `text-dimmed`, `text-highlighted`, `bg-default`, `bg-elevated`, `bg-accented`, `border-default`, `primary`/`error`/`success` scales, `dark:` variants, `font-display` (headings), `font-mono`. Icons: `<UIcon name="i-lucide-inbox" />`, the `i-lucide-*` set only, written literally — a name is parsed as `i-<collection>-<icon>`, so `` `i-${x}` `` names a collection that does not exist and renders an empty box. Icons arriving from the data (`fields[].options[].icon`, `targetIcon`) already carry their prefix: pass them to `<UIcon :name>` as they are, NEVER wrap them.',
  "Three contracts the compiler cannot check, each silent when broken. `color` takes only `primary`, `secondary`, `success`, `info`, `warning`, `error`, `neutral` — a Tailwind hue there (`violet`, `teal`) matches no variant, and setting the prop suppresses the default too, so it draws no colour at all; a hue from the DATA goes through `:style` and `var(--color-violet-500)`. `UModal`, `USlideover` and `UDrawer` take content in `#body` — their default slot is the trigger and renders inline on the page. Text written to be read formatted (a message composer, a note) is `UEditor` with `content-type`, never `UTextarea`.",
  "HTML you did not author (an email body, a stored description) will not respect your grid. Markdown goes through `<Markdown>` (the only sanitiser here); anything else sits in a container that bounds it: `max-w-full overflow-x-auto [&_img]:max-w-full [&_table]:max-w-full`. Unbounded it overflows horizontally, which the review counts as blocking. No nested iframe: the CSP declares no `frame-src`.",
  "",
  "## controls",
  "Every control is a Nuxt UI component, never a native tag: `USelect`/`USelectMenu` over `<select>`, `UInput`/`UTextarea` over `<input>`, `UButton` over `<button>`, `UTable` over `<table>`, `UModal`/`USlideover` over a hand-rolled overlay, `UCheckbox`/`USwitch` over a checkbox. A native control ignores the design tokens, loses the keyboard and focus behaviour the rest of the app has, and is a BLOCKING review finding.",
  "A control that carries state declares it: `:aria-pressed` on a toggle, `aria-selected` (or `UTabs`) on a tab, `aria-current` on the active item of a list. Without it the state lives only in a colour, and the review — which clicks what looks clickable and re-reads the DOM — reports a working toggle as a control that does nothing.",
  "",
  "## the bridge — `import { fretik } from '#fretik/sdk'`",
  "The bridge runs the datasets `page.json` DECLARES and nothing else — a config passed to the call, or built in a `lib/` module, is ignored and the page renders empty. Same for `ops.run` on an undeclared id: refused. The build names both.",
  "`await fretik.data.query({ variables?, datasetIds?, queries?, fresh? })` → `{ datasets: { <id>: result } }`. A result is `{ status: 'ok', rows, totalCount?, fields?, page?, pageSize? }` or `{ status: 'forbidden' | 'needs_connection' | 'error' }` — render every status, not just ok. `queries` pages/sorts an `collections` dataset server-side, per dataset: `{ orders: { page: 2, pageSize: 25, sortBy: 'date', sortDir: 'desc' } }`. On an AGGREGATE it takes `sortBy` (a metric name, or `group`/`series`) and `pageSize` (how many groups — top 10 becomes top 20); `page` means nothing there. An `external` dataset ignores `queries` — its `args` are the provider action's own parameters, so it pages only where that action offers an offset or a cursor to bind a variable to.",
  "NEVER invent rows. A dataset that answers nothing, `error` or `needs_connection` renders that state and names the dataset; a `mockData()`, a `catch` that fills refs, a `rows.length === 0` branch that substitutes examples is refused at build. Rows that are genuinely part of the design — a fixed legend, a reference table — go in an `inline` dataset, declared for what they are.",
  "An external app that answers one call at a time makes a single big query as slow as its slowest source: query each dataset on its own with `datasetIds` and render each as it lands. A source still working answers `{ status: 'error', retryAfterMs }` — show it loading and ask again after that delay, rather than settling on unavailable.",
  "`await fretik.ops.run('<operationId>', { variables? })` → verdict `{ status: 'ok' | 'needs_connection' | 'blocked' | 'cancelled' | 'error', message? }`. The PARENT app shows the confirmation for destructive operations — render the verdict (toast the outcome), never re-confirm.",
  "Every control that promises a write calls it. Faking the effect — a success toast with no `ops.run`, a `setTimeout` for the network, a local edit to server data — is the worst thing a page can ship, because it looks right to everyone, you included. A mail client shipped that way and sent nothing. When an action cannot be wired, leave its control out and say which.",
  "`fretik.ui.openUrl(url)` — plain `<a href>` clicks are routed through the parent automatically. `await fretik.ui.copy(text)` → `{ ok }`: the host writes the clipboard and says NOTHING, so the confirmation is yours — toast on `ok` naming what was copied, and say so when it is false.",
  "`fretik.theme.color('blue' | 'blue-600' | 'primary' | '--any-var')` → the CONCRETE colour. Required for anything drawn on a canvas (Chart.js): canvas cannot resolve `var(--…)`, drops it silently and paints black. CSS `:style` bindings need no such thing.",
  "`fretik.context` — reactive `{ dark, locale, mode, variables }`. Colors/dark-mode are synced automatically; read `dark`/`locale`/`mode` only when the CODE must branch.",
  "`fretik.context.variables` is how a SHARED LINK reopens the page where its sender left it: the host mirrors every variable you send into the url (`?v.<key>=…`) and hands them back here at startup. Seed each control's ref from it — `const status = ref(fretik.context.variables.status ?? 'all')` — or the url fills up anyway and the link promises a state the page ignores.",
  "",
  "## sandbox rules",
  "No `fetch`/XHR/WebSocket (CSP blocks all network — data comes from `fretik.data.query` only). No `localStorage`/`sessionStorage` (opaque origin — they throw; keep state in refs). No `window.open` (use `fretik.ui.openUrl`). External images over https are allowed in `<img>`.",
  "",
  "## vue",
  "Vue 3.5. Props are typed — `const props = defineProps<{ rows: Row[]; currency?: string }>()`; destructuring them keeps them reactive, but a default for an object or an array needs `withDefaults` with a factory (`() => []`). Emits are typed the same way (`const emit = defineEmits<{ select: [id: string] }>()`) and calling `emit` you never declared does nothing. Two-way state is `defineModel<T>()`.",
  "`.value` belongs to the script: a template unwraps refs itself, so `{{ rows.value }}` renders nothing. A composable is called at the top level of setup — calling it inside a handler or `onMounted` hands back a second, disconnected copy of its state — and returns a flat object of refs (`{ rows, status, reload }`) the caller destructures. A template ref (`ref<HTMLElement | null>(null)`) is still null until `onMounted`. Context shared down a tree goes through `provide`/`inject` with a typed `InjectionKey<T>`.",
  "",
  "## shape of a page",
  "Loading lives in `composables/usePageData.ts`: one `fretik.data.query()` in `onMounted`, rows in refs, targeted `datasetIds` refetches, and the flat object every region reads — so one value has one source on the whole page. HOW the page should then look and behave — layout, component choice, formatting through `fields`, chart wiring, the four dataset states — is `skills/building-pages/`.",
].join("\n");

/**
 * The full environment contract: the runtime guide plus the data grammar.
 *
 * Deterministic — it changes only when the schema or this file does — so it is
 * safe to sit in a cached system prefix.
 */
export const renderPageEnvironmentContract = (): string =>
  `${PAGE_ENVIRONMENT_GUIDE}\n\n${describePageDataContract()}`;
