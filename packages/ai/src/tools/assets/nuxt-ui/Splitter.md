# USplitter

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Splitter component
 */
interface SplitterProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * A unique id for the group, also used to derive the ids of its panels and handles.
   * Set it when rendering on the server, auto-generated ids can differ between the server and the client and break resizing on hydration.
   */
  id?: string | undefined;
  /**
   * The orientation of the splitter.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  items?: T[] | undefined;
  /**
   * Whether the resize handles are disabled, locking the current layout.
   * @default false
   */
  disabled?: boolean | undefined;
  ui?: { root?: SlotClass; panel?: SlotClass; handle?: SlotClass } | undefined;
  /**
   * Unique id used to auto-save group arrangement via `localStorage`.
   */
  autoSaveId?: null | string | undefined;
  /**
   * Step size when arrow key was pressed.
   */
  keyboardResizeBy?: null | number | undefined;
  /**
   * Custom storage API; defaults to localStorage
   */
  storage?: PanelGroupStorage | undefined;
  /**
   * Allow this much margin when determining resizable handle hit detection
   */
  hitAreaMargins?: PointerHitAreaMargins | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Splitter component
 */
interface SplitterSlots {
  resize-handle(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Splitter component
 */
interface SplitterEmits {
  layout: (payload: [val: number[]]) => void;
  collapse: (payload: [index: number]) => void;
  expand: (payload: [index: number]) => void;
  resize: (
    payload: [index: number, size: number, prevSize?: number | undefined],
  ) => void;
  dragging: (payload: [index: number, dragging: boolean]) => void;
}
```

## Usage

Use the Splitter component to display a list of resizable panels separated by draggable handles.

```vue [SplitterExample.vue]
<script setup lang="ts">
import type { SplitterItem } from "@nuxt/ui";

const card =
  "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium";

const items: SplitterItem[] = [
  { slot: "left", minSize: 15, defaultSize: 25, class: card },
  { slot: "main", minSize: 30, defaultSize: 50, class: card },
  { slot: "right", minSize: 15, defaultSize: 25, class: card },
];
</script>

<template>
  <div class="w-full h-96">
    <USplitter id="splitter-example" :items="items">
      <template #left> Left </template>

      <template #main> Main </template>

      <template #right> Right </template>
    </USplitter>
  </div>
</template>
```

> \[!NOTE]
>
> The Splitter fills the height of its container, so make sure a parent element defines one.

### Items

Use the `items` prop as an array of objects with the following properties:

- `defaultSize?: number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `minSize?: number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `maxSize?: number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `collapsible?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `collapsedSize?: number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `sizeUnit?: '%' | 'px'`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `order?: number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `id?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { panel?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

Use the `slot` key to fill the content of a panel and the `class` key to style it. Items without a `slot` key fall back to a `panel-{index}` slot. Sizes are percentages by default, set `sizeUnit: 'px'` on an item for pixel values.

> \[!CAUTION]
>
> When rendering on the server, set the `id` prop and give `defaultSize` to all items or to none. Ids are generated automatically otherwise and the server and the client can disagree, which breaks the layout on hydration. An item without a `defaultSize` falls back to an equal share on the server, so mixing the two makes panels jump once hydrated. Pixel sizes are measured on the client and always shift a little.

```vue
<script setup lang="ts">
import type { SplitterItem } from "@nuxt/ui";

const items = ref<SplitterItem[]>([
  {
    slot: "sidebar",
    minSize: 15,
    maxSize: 40,
    defaultSize: 25,
    class:
      "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium",
  },
  {
    slot: "main",
    defaultSize: 75,
    class:
      "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium",
  },
]);
</script>

<template>
  <USplitter id="splitter-items" :items="items">
    <template #sidebar> Sidebar </template>
    <template #main> Main </template></USplitter
  >
</template>
```

### Orientation

Use the `orientation` prop to change the direction of the splitter. Defaults to `horizontal`.

```vue
<script setup lang="ts">
import type { SplitterItem } from "@nuxt/ui";

const items = ref<SplitterItem[]>([
  {
    slot: "first",
    class:
      "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium",
  },
  {
    slot: "second",
    class:
      "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium",
  },
]);
</script>

<template>
  <USplitter id="splitter-orientation" orientation="vertical" :items="items">
    <template #first> First </template>
    <template #second> Second </template></USplitter
  >
</template>
```

## Examples

### With collapsible panel

Set `collapsible: true` on an item to let it collapse past its `minSize`, and use `collapsedSize` to keep part of the panel visible when collapsed. The panel slot exposes `collapsed`, `collapse` and `expand` so you can control it programmatically, and the `collapse`, `expand` and `resize` events fire with the panel index.

```vue [SplitterCollapsibleExample.vue]
<script setup lang="ts">
import type { SplitterItem } from "@nuxt/ui";

const items: SplitterItem[] = [
  {
    slot: "sidebar",
    sizeUnit: "px",
    minSize: 150,
    defaultSize: 250,
    collapsible: true,
    collapsedSize: 48,
    class: "bg-elevated/50 border border-default rounded-xl",
  },
  {
    slot: "main",
    class:
      "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium",
  },
];
</script>

<template>
  <div class="w-full h-96">
    <USplitter id="splitter-collapsible-example" :items="items">
      <template #sidebar="{ collapsed, collapse, expand }">
        <div class="flex-1 flex items-center justify-center p-2">
          <UButton
            :icon="
              collapsed
                ? 'i-lucide-panel-left-open'
                : 'i-lucide-panel-left-close'
            "
            :label="collapsed ? undefined : 'Collapse'"
            :aria-label="collapsed ? 'Expand' : undefined"
            color="neutral"
            variant="subtle"
            @click="collapsed ? expand() : collapse()"
          />
        </div>
      </template>

      <template #main> Main </template>
    </USplitter>
  </div>
</template>
```

### With nested splitters

Nest a `Splitter` inside a panel to build two-dimensional, IDE-style layouts.

```vue [SplitterNestedExample.vue]
<script setup lang="ts">
import type { SplitterItem } from "@nuxt/ui";

const card =
  "bg-elevated/50 border border-default rounded-xl items-center justify-center text-muted font-medium";

const items: SplitterItem[] = [
  { slot: "left", minSize: 20, class: card },
  { slot: "right", minSize: 20 },
];

const nested: SplitterItem[] = [
  { slot: "top", minSize: 20, class: card },
  { slot: "bottom", minSize: 20, class: card },
];
</script>

<template>
  <div class="w-full h-96">
    <USplitter id="splitter-nested-example" :items="items">
      <template #left> Left </template>

      <template #right>
        <USplitter
          id="splitter-nested-example-inner"
          orientation="vertical"
          :items="nested"
        >
          <template #top> Top </template>

          <template #bottom> Bottom </template>
        </USplitter>
      </template>
    </USplitter>
  </div>
</template>
```

### With custom handle

The handle is invisible by default. Use the `ui` prop to restyle it, for example as a visible divider for flush layouts, and the `resize-handle` slot to render content inside it like a grip.

```vue [SplitterCustomHandleExample.vue]
<script setup lang="ts">
import type { SplitterItem } from "@nuxt/ui";

const items: SplitterItem[] = [
  {
    slot: "left",
    minSize: 20,
    defaultSize: 30,
    class: "items-center justify-center text-muted font-medium",
  },
  {
    slot: "right",
    defaultSize: 70,
    class: "items-center justify-center text-muted font-medium",
  },
];
</script>

<template>
  <div class="w-full h-96">
    <USplitter
      id="splitter-custom-handle-example"
      :items="items"
      :ui="{
        handle:
          'data-[orientation=horizontal]:w-px data-[orientation=vertical]:h-px bg-border transition-colors data-[state=hover]:bg-primary data-[state=drag]:bg-primary',
      }"
      class="rounded-lg border border-default overflow-hidden"
    >
      <template #left> Left </template>

      <template #right> Right </template>
    </USplitter>
  </div>
</template>
```

### With persistence

Provide an `auto-save-id` to persist the layout to `localStorage` and restore it on reload.

```vue
<template>
  <USplitter id="my-layout" auto-save-id="my-layout" :items="items">
    <!-- ... -->
  </USplitter>
</template>
```
