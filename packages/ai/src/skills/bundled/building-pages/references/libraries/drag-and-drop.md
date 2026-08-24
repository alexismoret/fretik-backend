# Library — Pragmatic drag and drop

`@atlaskit/pragmatic-drag-and-drop/{element/adapter,combine,reorder}` and `@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge`. Read this before your first `draggable()` in a page. It is the library for EVERY drag shape — a board, a reorderable list, a tree, a scheduler, a two-pane picker — because there is no drag-and-drop component: you decorate your own markup.

Four calls do all of it:

- `draggable({ element, getInitialData })` — this element can be picked up.
- `dropTargetForElements({ element, canDrop, onDragEnter, onDragLeave, onDrop })` — this element accepts a drop.
- `combine(a, b, …)` — one element that is both, or has several behaviours; returns a single teardown.
- `reorder({ list, startIndex, finishIndex })` + `attachClosestEdge` / `extractClosestEdge` — moving WITHIN one list, where the answer is "above or below the row I landed on".

Every call returns a **teardown function**, and that is the whole difficulty.

## The registration trap — read this before writing the ref

**Measured 2026-08-21 on a shipped board: 24 cards draggable at mount, 0 after the first ordinary re-render, permanently.** The board looked perfect and no drop ever fired. This is the reason boards keep coming out beautiful and inert, so it is worth understanding rather than pattern-matching.

A page registers per-item, so the element arrives through a `v-for` ref callback:

```vue
<article v-for="card in cards" :key="card.id" :ref="(el) => registerCard(el, card)">
```

An inline arrow is a NEW function on every render, so Vue re-invokes it — **with the same DOM node**, because Vue patches elements in place. Re-registering the same node is already wasteful. What kills the board is the order in this shape:

```ts
// BROKEN — the teardown runs AFTER the new registration, on the same element.
const bind = (key: string, cleanup: (() => void) | null) => {
  cleanups.get(key)?.(); // ← previous teardown
  if (cleanup) cleanups.set(key, cleanup);
};
bind(`card:${card.id}`, draggable({ element: el })); // ← argument evaluated FIRST
```

JavaScript evaluates the argument before calling the function: `draggable()` registers the element, and only then does `bind` run the previous teardown — which unregisters that same element. Every render ends with the item dead, and the first render is the last one that works.

It is worse than a one-off, because the drag handlers themselves cause renders: `onDragEnter` setting an `overLane` ref re-renders the lane it just highlighted, so the drop target is torn down under the pointer. The trace is always the same — `dragstart`, `dragenter`, `dragover`, `dragleave`, `dragend`, and **no `drop`**.

**Register once per element, and do nothing when the node has not changed.** Verified to survive repeated re-renders and to leak nothing on unmount:

```ts
// One entry per key, holding the node it was bound to and its teardown.
const bound = new Map<string, { el: HTMLElement; cleanup: () => void }>();

const bind = (
  key: string,
  el: HTMLElement | null,
  register: (el: HTMLElement) => () => void,
) => {
  const previous = bound.get(key);
  if (previous && previous.el === el) return; // same node, same registration — nothing to do
  previous?.cleanup();
  bound.delete(key);
  if (!el) return; // Vue passes null when the element unmounts
  bound.set(key, { el, cleanup: register(el) });
};

onBeforeUnmount(() => {
  bound.forEach((entry) => entry.cleanup());
  bound.clear();
});
```

Called from the template, one line per registered element:

```ts
const registerCard = (el: HTMLElement | null, card: Card) =>
  bind(`card:${card.id}`, el, (node) =>
    draggable({
      element: node,
      getInitialData: () => ({ cardId: card.id, from: card.stage }),
      onDragStart: () => (draggingId.value = card.id),
      onDrop: () => (draggingId.value = null),
    }),
  );
```

Note what `register` is: a callback, not a value. Passing `draggable({…})` as an argument is what put the registration before the teardown.

## What a drop must do

`getInitialData` on the source is the only channel to the drop — `source.data` on the target is exactly what it returned, and nothing else travels. Keep it to identifiers (`{ cardId, from }`), never objects you expect to stay fresh.

A drop that changes data is **optimistic with a rollback**: move it in the local array, call the operation, put it back if the verdict is not `ok`. A drop that only looks like it worked is worse than one that refuses, because nobody reloads to check.

Declaring the operation is not optional. A board whose `record` operation is missing renders, animates and drops — and changes nothing.

## Shapes other than a board

- **Reorder inside one list**: the drop target is each ROW, `getData: ({ input, element }) => attachClosestEdge({ index }, { input, element, allowedEdges: ['top', 'bottom'] })`, then `extractClosestEdge(target.data)` on drop tells you which side, and `reorder({ list, startIndex, finishIndex })` produces the new array. Persist the new order — a reorder that is not written back is undone by the next query.
- **A drop zone that is not a list** (assign to a person, file into a folder): one `dropTargetForElements` per target, no reorder at all.
- **An element that is both** — a row you can drag AND drop onto, a lane that is itself draggable: `combine(draggable({…}), dropTargetForElements({…}))`, one teardown for both.

`canDrop` is what makes a target refuse; use it rather than letting a drop land and undoing it. And give the refusal a visible state — a target that quietly does nothing reads as a broken page.
