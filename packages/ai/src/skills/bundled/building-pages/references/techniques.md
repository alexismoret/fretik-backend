# Techniques

The moves that separate a working screen from a rendered list, and the traps that make a page wrong while it still compiles. None of it is tied to a component or a page family — reach for one whenever its condition appears.

WHICH component to reach for is not here: the catalogue is in your prompt, every registered component on one line. What a component ACCEPTS — props, slots, the snippet showing which part goes where — is `pageDocs`. This file is the third question, the one neither of those answers: what the shape of the problem asks for.

## Moves

**More content than the space allows** → bound the region and scroll inside it, and pin whatever orients the reader. A region that grows without limit pushes everything else off the screen and loses its own headings. `UTable` does both itself — a height class plus `sticky` keeps the column names visible while the rows scroll under them; elsewhere it is a `max-h-*` with `overflow-y-auto`, or `UScrollArea`. Do the same on the horizontal axis: a table wider than its column needs a scroll container the reader can see, never a silent clip at the edge.

**A class passed through `ui` REPLACES the library's own from the same group.** Tailwind merges by group, so yours wins and the one it displaced is gone with no error — name every class you still need, not only the one you are changing. Measured: `UTable`'s `base` ships `min-w-full`, so `:ui="{ base: 'min-w-[820px]' }"` buys the horizontal scroll and silently costs the table its full width, leaving a narrow slab with dead space beside it. `base: 'w-full min-w-[820px]'` keeps both.

**More rows than anyone should load at once** → fetch a page at a time and pull the next as the reader arrives at the edge. `useInfiniteScroll(scrollEl, load, { distance: 200 })` from `@vueuse/core`, with `load` asking the data contract for the next page and appending; guard it with a `hasMore` flag so it stops instead of hammering. A conversation loads the OTHER way — newest at the bottom, older pulled in at the top — so anchor the scroll before prepending or the reader gets thrown up the thread. When rows are cheap but numerous and all already in hand, `virtualize` on `UTable` or `useVirtualList` renders only what is visible; that is a different problem from not having fetched them.

**More items than fit on one line** → show the first few and put the rest one gesture away: a `UPopover` on hover, a `UTooltip` for plain text, a `UCollapsible` when it is a block. A bare `+4` that cannot be opened is a dead end.

**A value that carries a state** → a badge, a chip or a leading dot, wearing the data's own colour and icon (`references/data.md` § Colour).

**An action that belongs to one item** → put it on the item: a trailing button for the single obvious verb, a `UDropdownMenu` when there are several. When items can be selected, the same verbs move into a bar that appears with the selection.

**Opening an item from a list** → the whole row is the target. `UTable` emits `@select(event, row)` for exactly this — pair it with a pointer cursor and a hover on the row through `:ui="{ tr: … }"`, and `@click.stop` on the buttons inside so they keep their own meaning. (`@contextmenu` and `@hover` carry the same signature when a right-click menu or a hover preview fits.) In your own `v-for`, the click and the hover go on the item's outermost element.

**A number that needs a comparison** → pair it with the comparison in place: a `UProgress` under it, a delta beside it, a sparkline behind it.

**Several parallel views of the same subject** → `UTabs` when they are peers and the URL does not matter; a segmented row of `UButton`s when they are filters over one view; never two full tables stacked down the page.

**Two regions the reader weighs against each other** → `USplitter`, so the balance is theirs: a list beside the record it opens, filters beside results, a draft beside its preview. Panes are an `items` array of `{ slot, minSize, collapsible }` filled by the slot each one names, handles appear between them on their own, and the parent must carry a height — the splitter takes its own from it and collapses without one. `auto-save-id` saves nothing behind the sandbox, so never word a layout as remembered.

**Long free text** → `truncate` plus the full value on demand. Never let a cell decide silently how much of a value a person is allowed to read.

**Something the user should be able to move** → Pragmatic drag-and-drop. Nuxt UI has no draggable component, and this is the primitive: it decorates DOM elements you wrote, so it constrains no layout and fits a board, a reorderable list, a tree, a scheduler, a two-pane picker or a drop-on-target zone equally well. **Read `references/libraries/drag-and-drop.md` before your first call** — how you register an element decides whether any of it works, and the failure is silent: the drag animates and no drop ever fires. `references/pattern-board.md` is a complete working board.

**A destination the user will want** → make it a real link. Names, references and identifiers that exist somewhere else in the product should be clickable, not inert text.

## Overlays are one component with three animations

**`UModal`, `USlideover` and `UDrawer` are one component with three animations, and their slots are a NESTING, not a list.** Reading them as nine peers is what has broken three shipped pages, each time silently — the page compiled, rendered, and was wrong.

```vue
<USlideover v-model:open="open" title="…" description="…">
  <!-- default = the TRIGGER. It renders inline, on the page, always visible.
       Omit it entirely when you open the panel from code. -->
  <template #body>…</template>   <!-- the padded region. Your content goes HERE -->
  <template #footer>…</template> <!-- the actions bar -->
</USlideover>
```

- `default` is the trigger, never the content. A form placed there renders permanently in the page flow and the panel opens empty.
- `content` replaces the **whole panel** — header, body and footer at once. Use it only when you are rebuilding all three; the moment you reach for it you own the padding, the title and the close button, and the usual symptom of using it by mistake is a panel whose content is flush against the edges.
- `header` / `body` / `footer` are the padded parts. `title` / `description` / `actions` / `close` are pieces of the header, and `title` / `description` exist as props too — prefer the props.
- `UPopover` follows the same rule with two slots: `default` is the trigger, `content` is the panel.

The general form of the trap, which is worth carrying to any component: **a slot list tells you the names, never which one supersedes which.** When two slots could plausibly hold the same content, one of them is the container of the other — read the component's own example before choosing.

## Beyond Nuxt UI

Four more imports exist, for the things components alone cannot do. Reach for them only where the need is real — each one is a dependency the reader pays for.

| Import                                                                                                                            | For                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chart.js` / `chart.js/auto`                                                                                                      | Charts (`references/data.md` § Charts — colours must be resolved, timing is a trap)                                                                                                                                                                                                                                                                                                                                                                      |
| `@vueuse/core`                                                                                                                    | `useInfiniteScroll`, `useVirtualList`, `useIntersectionObserver`, `useScroll`, `useElementSize`, `useResizeObserver`, `useWindowSize`, `useMediaQuery`, `useDebounceFn`, `useThrottleFn`, `refDebounced`, `refThrottled`, `watchDebounced`, `watchThrottled`, `useIntervalFn`, `useTimeoutFn`, `useEventListener`, `onClickOutside`, `onKeyStroke`, `useMagicKeys`, `useFocus`, `useMouseInElement`, `useElementVisibility`, `useCycleList`, `useToggle` |
| `@internationalized/date`                                                                                                         | The value type `UCalendar` / `UInputDate` / `UInputTime` take — `CalendarDate`, `parseDate`, `today`, `getLocalTimeZone`. They take these, never a `Date`                                                                                                                                                                                                                                                                                                |
| `@atlaskit/pragmatic-drag-and-drop/{element/adapter,combine,reorder}` and `@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge` | Drag and drop of any shape — `references/libraries/drag-and-drop.md` first                                                                                                                                                                                                                                                                                                                                                                               |

Only the composables listed above exist on `@vueuse/core` here. The rest of VueUse is deliberately absent: storage, fetch, websocket and clipboard composables cannot work behind an opaque origin with no network, and would fail in the user's face rather than at save time. Copy through `fretik.ui.copy`.
