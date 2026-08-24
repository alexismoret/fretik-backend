# UProgress

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Progress component
 */
interface ProgressProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The maximum progress value.
   */
  max?: number | any[] | undefined;
  /**
   * Display the current progress value.
   */
  status?: boolean | undefined;
  /**
   * Whether the progress is visually inverted.
   * @default false
   */
  inverted?: boolean | undefined;
  /**
   * @default 'md'
   */
  size?: "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | undefined;
  /**
   * Any theme color, or any CSS color value for palettes outside the theme.
   * @default 'primary'
   */
  color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | string & {} | undefined;
  /**
   * The orientation of the progress bar.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * The animation of the progress bar.
   * @default 'carousel'
   */
  animation?: "carousel" | "carousel-inverse" | "swing" | "elastic" | undefined;
  ui?: { root?: SlotClass; base?: SlotClass; indicator?: SlotClass; status?: SlotClass; steps?: SlotClass; step?: SlotClass; } | undefined;
  /**
   * A function to get the accessible label text in a human-readable format.
   *
   *  If not provided, the value label will be read as the numeric value as a percentage of the max value.
   */
  getValueLabel?: (value: number | null | undefined, max: number): string | undefined | undefined;
  /**
   * A function to get the accessible value text representing the current value in a human-readable format.
   */
  getValueText?: (value: number | null | undefined, max: number): string | undefined | undefined;
  /**
   * The progress value. Can be bind as `v-model`.
   * @default null
   */
  modelValue?: null | number | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Progress component
 */
interface ProgressSlots {
  status(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Progress component
 */
interface ProgressEmits {
  update:modelValue: (payload: [value: string[] | undefined]) => void;
  update:max: (payload: [value: number]) => void;
}
```

## Usage

Use the `v-model` directive to control the value of the Progress.

```vue
<script setup lang="ts">
const value = ref(50);
</script>

<template>
  <UProgress v-model="value" />
</template>
```

> \[!NOTE]
>
> Use the [`ProgressGroup`](https://ui.nuxt.com/docs/components/progress-group) component to split a single bar into multiple segments that add up to a total.

### Max

Use the `max` prop to set the maximum value of the Progress.

```vue
<script setup lang="ts">
const value = ref(3);
</script>

<template>
  <UProgress v-model="value" :max="4" />
</template>
```

Use the `max` prop with an array of strings to display the active step under the bar, the maximum value of the Progress is the length of the array.

```vue
<script setup lang="ts">
const value = ref(3);
</script>

<template>
  <UProgress
    v-model="value"
    :max="['Waiting...', 'Cloning...', 'Migrating...', 'Deploying...', 'Done!']"
  />
</template>
```

### Status

Use the `status` prop to display the current Progress value above the bar.

```vue
<script setup lang="ts">
const value = ref(50);
</script>

<template>
  <UProgress v-model="value" status />
</template>
```

> \[!TIP]
>
> The status tracks the end of the bar, use `:ui="{ status: 'w-full' }"` to make it span the full width instead.

### Indeterminate

When no `v-model` is set or the value is `null`, the Progress becomes _indeterminate_. The progress bar is animated as a `carousel`, but you can change it using the [`animation`](https://ui.nuxt.com/#animation) prop.

```vue
<script setup lang="ts">
const value = ref(null);
</script>

<template>
  <UProgress />
</template>
```

### Animation

Use the `animation` prop to change the animation of the Progress to an inverse carousel, a swinging bar or an elastic bar. Defaults to `carousel`.

```vue
<template>
  <UProgress animation="swing" />
</template>
```

> \[!TIP]
>
> The animation is automatically disabled when the user prefers reduced motion, the indeterminate bar is displayed as a full width pulse instead.

### Orientation

Use the `orientation` prop to change the orientation of the Progress. Defaults to `horizontal`.

```vue
<template>
  <UProgress orientation="vertical" class="h-48" />
</template>
```

### Color

Use the `color` prop to change the color of the Progress.

```vue
<template>
  <UProgress color="neutral" />
</template>
```

> \[!TIP]
>
> This prop also accepts any CSS color value for palettes outside the theme.

### Size

Use the `size` prop to change the size of the Progress.

```vue
<template>
  <UProgress size="xl" />
</template>
```

### Inverted

Use the `inverted` prop to visually invert the Progress.

```vue
<template>
  <UProgress inverted v-model="value" />
</template>
```
