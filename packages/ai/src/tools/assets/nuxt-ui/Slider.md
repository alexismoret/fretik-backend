# USlider

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Slider component
 */
interface SliderProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
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
    | undefined;
  /**
   * The orientation of the slider.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * Display a tooltip around the slider thumbs with the current value.
   * `{ disableClosingTrigger: true }`{lang="ts-type"}
   * @default false
   */
  tooltip?: boolean | TooltipProps | undefined;
  /**
   * The value of the slider when initially rendered. Use when you do not need to control the state of the slider.
   */
  defaultValue?: number | number[] | undefined;
  ui?:
    | {
        root?: SlotClass;
        track?: SlotClass;
        range?: SlotClass;
        thumb?: SlotClass;
      }
    | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, prevents the user from interacting with the slider.
   */
  disabled?: boolean | undefined;
  /**
   * Whether the slider is visually inverted.
   */
  inverted?: boolean | undefined;
  /**
   * The minimum value for the range.
   * @default 0
   */
  min?: number | undefined;
  /**
   * The maximum value for the range.
   * @default 100
   */
  max?: number | undefined;
  /**
   * The stepping interval.
   * @default 1
   */
  step?: number | undefined;
  /**
   * The minimum permitted steps between multiple thumbs.
   */
  minStepsBetweenThumbs?: number | undefined;
  modelValue?: T | undefined;
}
```

### Emits

```ts
/**
 * Emitted events for the Slider component
 */
interface SliderEmits {
  change: (payload: [event: Event]) => void;
  update:modelValue: (payload: [value: T | undefined]) => void;
}
```

## Usage

Use the `v-model` directive to control the value of the Slider.

```vue
<script setup lang="ts">
const value = ref(50);
</script>

<template>
  <USlider v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <USlider :default-value="50" />
</template>
```

### Min / Max

Use the `min` and `max` props to set the minimum and maximum values of the Slider. Defaults to `0` and `100`.

```vue
<template>
  <USlider :min="0" :max="50" :default-value="50" />
</template>
```

### Step

Use the `step` prop to set the increment value of the Slider. Defaults to `1`.

```vue
<template>
  <USlider :step="10" :default-value="50" />
</template>
```

### Multiple

Use the `v-model` directive or the `default-value` prop with an array of values to create a range Slider.

```vue
<script setup lang="ts">
const value = ref([25, 75]);
</script>

<template>
  <USlider v-model="value" />
</template>
```

Use the `min-steps-between-thumbs` prop to limit the minimum distance between the thumbs.

```vue
<script setup lang="ts">
const value = ref([25, 50, 75]);
</script>

<template>
  <USlider v-model="value" :min-steps-between-thumbs="10" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the Slider. Defaults to `horizontal`.

```vue
<template>
  <USlider orientation="vertical" :default-value="50" class="h-48" />
</template>
```

### Color

Use the `color` prop to change the color of the Slider.

```vue
<template>
  <USlider color="neutral" :default-value="50" />
</template>
```

### Size

Use the `size` prop to change the size of the Slider.

```vue
<template>
  <USlider size="xl" :default-value="50" />
</template>
```

### Tooltip

Use the `tooltip` prop to display a [Tooltip](https://ui.nuxt.com/docs/components/tooltip) around the Slider thumbs with the current value. You can set it to `true` for default behavior or pass an object to customize it with any property from the [Tooltip](https://ui.nuxt.com/docs/components/tooltip#props) component.

```vue
<template>
  <USlider :default-value="50" tooltip />
</template>
```

### Disabled

Use the `disabled` prop to disable the Slider.

```vue
<template>
  <USlider disabled :default-value="50" />
</template>
```

### Inverted

Use the `inverted` prop to visually invert the Slider.

```vue
<template>
  <USlider inverted :default-value="25" />
</template>
```
