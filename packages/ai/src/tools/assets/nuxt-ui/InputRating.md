# UInputRating

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the InputRating component
 */
interface InputRatingProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The id of the rating.
   */
  id?: string | undefined;
  /**
   * Make the rating readonly (non-interactive).
   * @default false
   */
  readonly?: boolean | undefined;
  /**
   * The icon displayed for each rating value.
   * @default appConfig.ui.icons.star
   */
  icon?: any;
  /**
   * The icon displayed for empty rating values. Defaults to `icon` when not provided.
   */
  emptyIcon?: any;
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
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * The orientation of the rating.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  ui?:
    | {
        root?: SlotClass;
        item?: SlotClass;
        indicator?: SlotClass;
        icon?: SlotClass;
        emptyIcon?: SlotClass;
      }
    | undefined;
  /**
   * The granularity each rating item is divided into.
   * @default 1
   */
  step?: 1 | 0.5 | 0.25 | 0.1 | undefined;
  /**
   * When `true`, prevents the user from interacting with radio items.
   */
  disabled?: boolean | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * The controlled rating value. Can be bound with `v-model`.
   */
  modelValue?: number | undefined;
  /**
   * The rating value when initially rendered. Use when you do not need to control the state of the rating.
   * @default 0
   */
  defaultValue?: number | undefined;
  /**
   * The number of rating items to render.
   * @default 5
   */
  length?: number | undefined;
  /**
   * When `true`, clicking the currently selected rating resets the value to `0`.
   * @default false
   */
  clearable?: boolean | undefined;
  /**
   * When `true`, the rating previews the value under the pointer on hover.
   * @default false
   */
  hoverable?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the InputRating component
 */
interface InputRatingSlots {
  /**
   * Rendered for each item. `filled` is `false` for the empty background layer and `true` for the highlighted overlay.
   */
  item(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the InputRating component
 */
interface InputRatingEmits {
  update:modelValue: (payload: [payload: number]) => void;
  change: (payload: [event: Event]) => void;
}
```

## Usage

Use the `v-model` directive to control the rating value of the InputRating component.

```vue
<script setup lang="ts">
const value = ref(3);
</script>

<template>
  <UInputRating v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <UInputRating :default-value="3" />
</template>
```

### Step

Use the `step` prop to control the granularity of each star. Set it to `0.5` to allow half-star ratings.

```vue
<template>
  <UInputRating :step="0.5" :default-value="3.5" />
</template>
```

### Length

Use the `length` prop to set the number of stars. Defaults to `5`.

```vue
<template>
  <UInputRating :length="10" :step="0.5" :default-value="7.5" />
</template>
```

### Clearable

Use the `clearable` prop to allow users to clear the rating by clicking on the currently selected value. Defaults to `false`.

```vue
<template>
  <UInputRating clearable :default-value="3" />
</template>
```

### Hoverable

Use the `hoverable` prop to control whether the rating previews the value when hovering over the stars. Defaults to `false`.

```vue
<template>
  <UInputRating hoverable :default-value="3" />
</template>
```

### Icon

Use the `icon` prop to customize the icon used for stars. Defaults to `i-lucide-star`.

```vue
<template>
  <UInputRating icon="i-lucide-heart" :default-value="4" />
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize the default star icon globally in your `app.config.ts` under `ui.icons.star` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize the default star icon globally in your `vite.config.ts` under `ui.icons.star` key.

### Empty Icon

Use the `empty-icon` prop to customize the icon used for empty stars. If not provided, uses the same icon as `icon`.

```vue
<template>
  <UInputRating
    empty-icon="i-ph-star"
    icon="i-ph-star-fill"
    :default-value="3"
  />
</template>
```

### Color

Use the `color` prop to change the color of the filled stars.

```vue
<template>
  <UInputRating color="neutral" :default-value="4" />
</template>
```

### Size

Use the `size` prop to change the size of the stars.

```vue
<template>
  <UInputRating size="xl" :default-value="4" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the rating. Defaults to `horizontal`.

```vue
<template>
  <UInputRating orientation="vertical" :default-value="4" />
</template>
```

### Disabled

Use the `disabled` prop to disable the InputRating component. When disabled, the component has reduced opacity (75%) and shows a `not-allowed` cursor to indicate it's not interactive.

```vue
<template>
  <UInputRating disabled :default-value="3" />
</template>
```

### Readonly

Use the `readonly` prop to display a rating without allowing user interaction. Unlike `disabled`, it maintains normal appearance (full opacity, default cursor). Use when you want to display a rating that cannot be changed but should look normal.

```vue
<template>
  <UInputRating readonly :default-value="4.5" />
</template>
```
