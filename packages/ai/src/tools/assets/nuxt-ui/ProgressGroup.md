# UProgressGroup

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ProgressGroup component
 */
interface ProgressGroupProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  items?: T[] | undefined;
  /**
   * The value all items add up to, used to compute each segment's share of the track.
   * @default 100
   */
  max?: number | undefined;
  /**
   * Display the summed progress value.
   */
  status?: boolean | undefined;
  /**
   * @default 'md'
   */
  size?: "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | undefined;
  /**
   * Any theme color, or any CSS color value for palettes outside the theme.
   * @default 'primary'
   */
  color?:
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | "error"
    | "neutral"
    | (string & {})
    | undefined;
  /**
   * The orientation of the progress bar.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  ui?:
    | {
        root?: SlotClass;
        base?: SlotClass;
        segment?: SlotClass;
        indicator?: SlotClass;
        status?: SlotClass;
        list?: SlotClass;
        item?: SlotClass;
        itemLeadingIcon?: SlotClass;
        itemLeadingDot?: SlotClass;
        itemLabel?: SlotClass;
        itemTrailing?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ProgressGroup component
 */
interface ProgressGroupSlots {
  status(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-trailing(): any;
}
```

## Usage

Use the ProgressGroup component to display multiple values as segments of a single progress bar.

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "System",
    value: 24,
    color: "neutral",
    icon: "i-lucide-cog",
  },
  {
    label: "Apps",
    value: 8,
    color: "error",
    icon: "i-lucide-app-window",
  },
  {
    label: "Documents",
    value: 12,
    color: "warning",
    icon: "i-lucide-file",
  },
  {
    label: "Multimedia",
    value: 42,
    color: "success",
    icon: "i-lucide-film",
  },
]);
</script>

<template>
  <UProgressGroup :max="128" :items="items" class="w-96" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `value?: number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | (string & {})`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-custom-colors)
- `slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { segment?: ClassNameValue, indicator?: ClassNameValue, item?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingDot?: ClassNameValue, itemLabel?: ClassNameValue, itemTrailing?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "Compute",
    value: 42,
    color: "primary",
  },
  {
    label: "Storage",
    value: 18,
    color: "info",
  },
  {
    label: "Bandwidth",
    value: 9,
    color: "warning",
  },
]);
</script>

<template>
  <UProgressGroup :items="items" class="w-96" />
</template>
```

> \[!NOTE]
>
> Items without an `icon` get a colored dot in the list instead.

### Max

Use the `max` prop to set the value all items add up to. Defaults to `100`.

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "Used",
    value: 128,
    color: "primary",
  },
  {
    label: "Reserved",
    value: 64,
    color: "neutral",
  },
]);
</script>

<template>
  <UProgressGroup :max="512" :items="items" class="w-96" />
</template>
```

> \[!NOTE]
>
> Values are clamped between `0` and `max`, and segments that add up to more than `max` share the track proportionally.

### Status

Use the `status` prop to display the summed value above the bar.

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "System",
    value: 24,
    color: "neutral",
  },
  {
    label: "Apps",
    value: 8,
    color: "error",
  },
  {
    label: "Multimedia",
    value: 42,
    color: "success",
  },
]);
</script>

<template>
  <UProgressGroup status :max="128" :items="items" class="w-96" />
</template>
```

> \[!TIP]
>
> The status tracks the end of the bar, use `:ui="{ status: 'w-full' }"` to make it span the full width instead.

### Color

Use the `color` prop to change the color of every segment that doesn't set its own.

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "Read",
    value: 42,
  },
  {
    label: "Write",
    value: 18,
  },
]);
</script>

<template>
  <UProgressGroup color="neutral" :items="items" class="w-96" />
</template>
```

> \[!TIP]
>
> Both this prop and each item's `color` accept any CSS color value, which is handy for palettes outside the theme.

### Size

Use the `size` prop to change the size of the ProgressGroup.

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "Read",
    value: 42,
    color: "primary",
  },
  {
    label: "Write",
    value: 18,
    color: "info",
  },
]);
</script>

<template>
  <UProgressGroup size="xl" :items="items" class="w-96" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the ProgressGroup. Defaults to `horizontal`.

```vue
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items = ref<ProgressGroupItem[]>([
  {
    label: "Read",
    value: 42,
    color: "primary",
  },
  {
    label: "Write",
    value: 18,
    color: "info",
  },
]);
</script>

<template>
  <UProgressGroup orientation="vertical" :items="items" class="h-48" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With status slot

Use the `#status` slot to replace the summed percentage with your own content.

```vue [ProgressGroupStatusExample.vue]
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const max = 128;

const items: ProgressGroupItem[] = [
  { label: "System", value: 24, color: "neutral", icon: "i-lucide-cog" },
  { label: "Apps", value: 8, color: "error", icon: "i-lucide-app-window" },
  { label: "Documents", value: 12, color: "warning", icon: "i-lucide-file" },
  { label: "Multimedia", value: 42, color: "success", icon: "i-lucide-film" },
];

const used = items.reduce((total, item) => total + (item.value ?? 0), 0);
</script>

<template>
  <UProgressGroup
    :items="items"
    :max="max"
    status
    class="w-96"
    :ui="{ status: 'w-full justify-between' }"
  >
    <template #status>
      <p>{{ used }}GB used</p>
      <p class="text-muted">{{ max - used }}GB remaining</p>
    </template>
  </UProgressGroup>
</template>
```

### With item slots

Use the `#item-label` and `#item-trailing` slots to change what each entry displays. Both receive the `item`, its `index` and its `percent`.

```vue [ProgressGroupItemExample.vue]
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const items: ProgressGroupItem[] = [
  { label: "System", value: 24, color: "neutral" },
  { label: "Apps", value: 8, color: "error" },
  { label: "Documents", value: 12, color: "warning" },
  { label: "Multimedia", value: 42, color: "success" },
];
</script>

<template>
  <UProgressGroup :items="items" :max="128" class="w-96">
    <template #item-label="{ item }">
      <span class="font-medium">{{ item.label }}</span>
    </template>

    <template #item-trailing="{ item }"> {{ item.value }}GB </template>
  </UProgressGroup>
</template>
```

### With custom colors

Give each item a CSS color to build a breakdown outside the theme palette.

```vue [ProgressGroupCustomColorExample.vue]
<script setup lang="ts">
import type { ProgressGroupItem } from "@nuxt/ui";

const max = 128;

const items: ProgressGroupItem[] = [
  { label: "System prompt", value: 4.2, color: "var(--color-neutral-400)" },
  { label: "Tool definitions", value: 18.4, color: "var(--color-violet-400)" },
  { label: "Rules", value: 12.8, color: "var(--color-green-400)" },
  { label: "Skills", value: 7.1, color: "var(--color-amber-400)" },
  { label: "MCP & dynamic tools", value: 17.1, color: "var(--color-rose-400)" },
  { label: "Subagent definitions", value: 5.5, color: "var(--color-sky-400)" },
  { label: "Conversation", value: 24.6, color: "var(--color-orange-400)" },
];

const used = items.reduce((total, item) => total + (item.value ?? 0), 0);
</script>

<template>
  <UProgressGroup
    :items="items"
    :max="max"
    status
    class="w-96"
    :ui="{ status: 'w-full justify-between' }"
  >
    <template #status="{ percent }">
      <p>{{ percent }}% Full</p>
      <p class="text-muted">~{{ used.toFixed(1) }}K / {{ max }}K Tokens</p>
    </template>

    <template #item-trailing="{ item }"> {{ item.value }}K </template>
  </UProgressGroup>
</template>
```
