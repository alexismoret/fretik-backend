# Choosing components

Every component below is registered globally in the page runtime — no import, just `<UBadge>`. This file says **which one to reach for**. For what a component actually accepts — every prop, slot, variant, default — call `managePage { action: "components", components: ["UTable", "USlideover"] }` (up to 6 per call) and read the real API before writing the template. Guessed props are silently dropped.

Two rules that decide most of it:

- **Reach for the most specific component that fits.** `UUser` over an avatar-plus-two-`<p>`s, `UEmpty` over a centred div, `UPageCard` over `UCard` plus manual icon markup. The specific one already handles spacing, truncation, dark mode and keyboard behaviour you would otherwise get wrong. The tell that you are rebuilding one badly: a `<div>` carrying a radius, a border and a background is a `UCard`; a `<button>` inside a table cell is `@select` on the table; a wrapper whose only job is a scrollbar is a prop on the component inside it. Every one of those loses the states, the focus handling and the theming that came free.
- **A container must earn its border.** Only wrap in `UCard` when the content is a unit that could move elsewhere whole. A heading plus spacing groups just as well and adds no noise. When you do use one, `variant` picks the surface — leave it at `outline` on a page, and reach for `soft` / `subtle` only for a region that genuinely sits above the rest.

## Display a value

| Value                             | Component                                                                   |
| --------------------------------- | --------------------------------------------------------------------------- |
| A status, a category, a count     | `UBadge` — `variant="subtle"` for data, `solid` for one deliberate emphasis |
| A person, an account, an owner    | `UUser` (avatar + name + description in one) or `UAvatar` alone in a cell   |
| Several people on one row         | `UAvatarGroup` with `:max`                                                  |
| A ratio, a score, a completion    | `UProgress` (`size="xs"` inside a row)                                      |
| A rating out of five              | `UInputRating` with `disabled`                                              |
| An icon                           | `UIcon` — `i-lucide-*` only                                                 |
| A keyboard shortcut               | `UKbd`                                                                      |
| A count badge on top of something | `UChip`                                                                     |
| A link out                        | `ULink`, or a plain `<a>` — both are routed through the app                 |
| Free-form long text               | plain markup with `text-sm text-muted`; do not put prose in a badge         |
| Text that may contain markdown    | `<Markdown :value="text" />`, `compact` to clamp it to two lines            |

## Show a set of records

| Shape                         | Component                                | When                                                                      |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Columns that get compared     | `UTable`                                 | Anything the user scans for outliers. The default for records             |
| A vertical list of rich items | `UPageList`, or your own `v-for` of rows | When each item needs two lines and a thumbnail more than it needs columns |
| Chronological events          | `UTimeline`                              | Activity, history, audit trails                                           |
| A hierarchy                   | `UTree`                                  | Folders, categories, org charts                                           |
| A gallery / cards             | `UPageGrid` + `UPageCard`                | Few items, each visual or needing its own actions                         |
| Cycling highlights            | `UCarousel`                              | Rarely — a carousel hides data                                            |
| Nothing to show               | `UEmpty`                                 | Always. Title says what is missing, description says what to do           |
| Not loaded yet                | `USkeleton`                              | Shaped like the content it replaces, never a spinner over the whole page  |

Every one of these renders its items through slots, so a value is never stuck as plain text — in `UTable` it is `#<column>-cell` with `row.original`, elsewhere it is the item slot. Headers and labels come from the dataset's own `fields[].label`, colours and icons from its `options` (`references/data.md`). `@tanstack/vue-table` is not importable: sort and paginate through the data contract, not the table's own row models.

## Techniques

These are the moves that separate a working screen from a rendered list. They are not tied to a component or a page family — reach for one whenever its condition appears, in whatever you are building.

**More content than the space allows** → bound the region and scroll inside it, and pin whatever orients the reader. A region that grows without limit pushes everything else off the screen and loses its own headings. `UTable` does both itself — a height class plus `sticky` keeps the column names visible while the rows scroll under them; elsewhere it is a `max-h-*` with `overflow-y-auto`, or `UScrollArea`. Do the same on the horizontal axis: a table wider than its column needs a scroll container the reader can see, never a silent clip at the edge.

**More rows than anyone should load at once** → fetch a page at a time and pull the next as the reader arrives at the edge. `useInfiniteScroll(scrollEl, load, { distance: 200 })` from `@vueuse/core`, with `load` asking the data contract for the next page and appending; guard it with a `hasMore` flag so it stops instead of hammering. A conversation loads the OTHER way — newest at the bottom, older pulled in at the top — so anchor the scroll before prepending or the reader gets thrown up the thread. When rows are cheap but numerous and all already in hand, `virtualize` on `UTable` or `useVirtualList` renders only what is visible; that is a different problem from not having fetched them.

**More items than fit on one line** → show the first few and put the rest one gesture away: a `UPopover` on hover, a `UTooltip` for plain text, a `UCollapsible` when it is a block. A bare `+4` that cannot be opened is a dead end.

**A value that carries a state** → give it the data's own colour and icon as a badge, a chip or a leading dot, and keep that colour for the same value everywhere on the page — cells, charts, legends, filters.

**Secondary detail that would crowd the primary view** → progressive disclosure, chosen by how much there is: hover for a word or two (`UTooltip`), a `UPopover` for a small block, a `USlideover` for a whole record, a `UModal` only when the user must finish or cancel before anything else.

**An action that belongs to one item** → put it on the item: a trailing button for the single obvious verb, a `UDropdownMenu` when there are several. When items can be selected, the same verbs move into a bar that appears with the selection.

**Opening an item from a list** → the whole row is the target. `UTable` emits `@select(event, row)` for exactly this — pair it with a pointer cursor and a hover on the row through `:ui="{ tr: … }"`, and `@click.stop` on the buttons inside so they keep their own meaning. (`@contextmenu` and `@hover` carry the same signature when a right-click menu or a hover preview fits.) In your own `v-for`, the click and the hover go on the item's outermost element.

**A number that needs a comparison** → pair it with the comparison in place: a `UProgress` under it, a delta beside it, a sparkline behind it.

**Several parallel views of the same subject** → `UTabs` when they are peers and the URL does not matter; a segmented row of `UButton`s when they are filters over one view; never two full tables stacked down the page.

**Long free text** → `truncate` plus the full value on demand. Never let a cell decide silently how much of a value a person is allowed to read.

**Something the user should be able to move** → Pragmatic drag-and-drop. Nuxt UI has no draggable component, and this is the primitive: it decorates DOM elements you wrote, so it constrains no layout and fits a board, a reorderable list, a tree, a scheduler, a picker with two panes, a drop-on-target zone equally well. Four calls carry all of it:

- `draggable({ element, getInitialData: () => ({ id }) })` — this element can be picked up, and this is what travels with it.
- `dropTargetForElements({ element, canDrop, getData, onDragEnter, onDragLeave, onDrop })` — this element accepts a drop. `onDrop` receives `{ source, location, self }`; `source.data` is what the draggable attached.
- `monitorForElements({ onDragStart, onDrop })` — a listener over the whole page, for state that is not any one element's business (what is currently being dragged, so the rest of the UI can respond).
- `combine(a, b, …)` — merges the cleanups into one.

Three rules make it work rather than leak. **Every one of those calls returns a cleanup function** — keep it and call it when the element goes away, or a `v-for` that re-renders registers the same node repeatedly. **Registration needs the real DOM node**, so it happens in a template-ref callback or `onMounted`, never at setup time. And **the drop only reports intent** — you still perform the change: apply it optimistically, call the operation, and put the item back if the verdict is not `ok`.

For "insert between two items" rather than "drop into a container", `attachClosestEdge` adds which edge the pointer is nearest to the drop data and `extractClosestEdge` reads it back on drop; `reorder({ list, startIndex, finishIndex })` does the array move. `references/patterns.md` § Board is a complete working one.

**A destination the user will want** → make it a real link. Names, references and identifiers that exist somewhere else in the product should be clickable, not inert text.

## Ask for input

| Need                                      | Component                                                |
| ----------------------------------------- | -------------------------------------------------------- |
| Text, email, password, search             | `UInput`                                                 |
| Long text                                 | `UTextarea` (`autoresize`)                               |
| Rich text a person will format            | `UEditor` + `UEditorToolbar`                             |
| A short known list (< 10)                 | `USelect`                                                |
| A long list, search, multi-select, groups | `USelectMenu`                                            |
| Type freely _or_ pick                     | `UInputMenu`                                             |
| Number with steppers                      | `UInputNumber`                                           |
| A date, or a range                        | `UInputDate`                                             |
| A time                                    | `UInputTime`                                             |
| Tags                                      | `UInputTags`                                             |
| A file                                    | `UFileUpload`                                            |
| On/off                                    | `USwitch` (a setting) or `UCheckbox` (an item in a list) |
| Several from a list                       | `UCheckboxGroup`                                         |
| One from a few, all visible               | `URadioGroup`                                            |
| A range                                   | `USlider`                                                |
| A colour                                  | `UColorPicker`                                           |
| A code                                    | `UPinInput`                                              |

Wrap every input in `UFormField` (label, description, error) and the set in `UForm` with a schema. Group inline inputs with `UFieldGroup`. Filters above a table are the exception — they are controls, not a form, and belong in a toolbar row.

## Layer something over the page

| Need                             | Component                                      |
| -------------------------------- | ---------------------------------------------- |
| The detail of a selected record  | `USlideover` — the default for "click a row"   |
| A focused task or a confirmation | `UModal`                                       |
| A mobile-style bottom sheet      | `UDrawer`                                      |
| Actions attached to a trigger    | `UDropdownMenu`                                |
| Right-click actions              | `UContextMenu`                                 |
| Extra context on demand          | `UPopover`                                     |
| A one-line hint                  | `UTooltip` — never anything interactive inside |
| Search-and-jump                  | `UCommandPalette`                              |

Destructive operations are confirmed by the app itself — never build your own confirm for those (`references/data.md`).

## Structure the page

| Need                                        | Component                      |
| ------------------------------------------- | ------------------------------ |
| A unit of content with a border             | `UCard`                        |
| A card with icon, badge, highlight or links | `UPageCard`                    |
| A grid of those                             | `UPageGrid`                    |
| A titled section with description           | `UPageHeader`, or plain markup |
| Side-by-side panes                          | `UPageColumns`, or a grid      |
| A max-width wrapper                         | `UContainer`                   |
| A divider, optionally labelled              | `USeparator`                   |
| Show/hide a block                           | `UCollapsible`                 |
| Several of those                            | `UAccordion`                   |
| Switch views in place                       | `UTabs`                        |
| Steps in a process                          | `UStepper`                     |
| Where you are                               | `UBreadcrumb`                  |
| Paging                                      | `UPagination`                  |
| A scroll region with its own bar            | `UScrollArea`                  |
| Scoped colour override for a subtree        | `UTheme`                       |

**Not for pages:** `UApp`, `UHeader`, `UFooter`, `UMain`, `UBanner`, `USidebar`, `UNavigationMenu`, and every `UDashboard*` — the app already provides the shell around your page, and a second navbar or sidebar inside it reads as a bug. `UAuthForm`, `UPricing*`, `UBlog*`, `UChangelog*`, `UPageHero`, `UPageSection`, `UPageCTA`, `UPageLogos` are marketing-site furniture; they look out of place in a working screen.

## Conversations and messaging

The `UChat*` family is a message-thread toolkit, not an assistant-only one. Reach for it whenever the subject is people talking — a mailbox, a ticket thread, comments on a record, a channel view rebuilt over a connected app, an approval discussion, or an actual assistant.

| Need                            | Component                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------- |
| The thread                      | `UChatMessages` — owns scrolling and the stick-to-bottom behaviour            |
| One message                     | `UChatMessage` — `id`, `role`, `parts`, plus `side` / `variant` / `avatar`    |
| The composer                    | `UChatPrompt` (autoresizing) + `UChatPromptSubmit` (its status-aware button)  |
| A message still arriving        | `status` on `UChatMessages` / `UChatPromptSubmit`; `UChatShimmer` as the tell |
| Command-style entry over a list | `UChatPalette`                                                                |

A message is `{ id, role: 'user' | 'assistant', parts: [{ type: 'text', text }] }`. Anything from a dataset maps onto that shape — an email, a comment row, a log line — and `role` is what decides the side, so use it for "us vs them" whatever the two sides really are. Give each message its author through `avatar`/`user`, since a thread with no faces reads as a log.

Two things a thread needs beyond the components: history that loads as the user scrolls UP (§ Techniques), and a `parts` array you build yourself — never interpolate a raw body into a template when it may carry markdown, which is what `<Markdown>` is for.

## Beyond Nuxt UI

Four more imports exist, for the things components alone cannot do. Reach for them only where the need is real — each one is a dependency the reader pays for.

| Import                                                                                                                            | For                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chart.js` / `chart.js/auto`                                                                                                      | Charts (`references/data.md` § Charts — colours must be resolved, timing is a trap)                                                                                                                                                                                                                                                                                                                                                                      |
| `@vueuse/core`                                                                                                                    | `useInfiniteScroll`, `useVirtualList`, `useIntersectionObserver`, `useScroll`, `useElementSize`, `useResizeObserver`, `useWindowSize`, `useMediaQuery`, `useDebounceFn`, `useThrottleFn`, `refDebounced`, `refThrottled`, `watchDebounced`, `watchThrottled`, `useIntervalFn`, `useTimeoutFn`, `useEventListener`, `onClickOutside`, `onKeyStroke`, `useMagicKeys`, `useFocus`, `useMouseInElement`, `useElementVisibility`, `useCycleList`, `useToggle` |
| `@internationalized/date`                                                                                                         | The value type `UCalendar` / `UInputDate` / `UInputTime` take — `CalendarDate`, `parseDate`, `today`, `getLocalTimeZone`. They take these, never a `Date`                                                                                                                                                                                                                                                                                                |
| `@atlaskit/pragmatic-drag-and-drop/{element/adapter,combine,reorder}` and `@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge` | Drag and drop of any shape (§ Techniques)                                                                                                                                                                                                                                                                                                                                                                                                                |

Only the composables listed above exist on `@vueuse/core` here. The rest of VueUse is deliberately absent: storage, fetch, websocket and clipboard composables cannot work behind an opaque origin with no network, and would fail in the user's face rather than at save time. Copy through `fretik.ui.copy`.

## Tell the user something

| Need                                   | Component                     |
| -------------------------------------- | ----------------------------- |
| The result of an action they just took | `useToast()` — auto-dismisses |
| A condition that persists on the page  | `UAlert`                      |
| Work in progress                       | `UProgress`, or `USkeleton`   |

Never put something the user must act on in a toast; it disappears.
