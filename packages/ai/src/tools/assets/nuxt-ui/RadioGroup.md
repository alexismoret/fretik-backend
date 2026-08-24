# URadioGroup

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the RadioGroup component
 */
interface RadioGroupProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  legend?: string | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the value.
   * @default 'value'
   */
  valueKey?: VK | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the label.
   * @default 'label'
   */
  labelKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the description.
   * @default 'description'
   */
  descriptionKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  items?: T | undefined;
  /**
   * The controlled value of the RadioGroup. Can be bind as `v-model`.
   */
  modelValue?: GetItemValue<T, VK, undefined, NestedItem<T>> | undefined;
  /**
   * The value of the RadioGroup when initially rendered. Use when you do not need to control the state of the RadioGroup.
   */
  defaultValue?: GetItemValue<T, VK, undefined, NestedItem<T>> | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * @default 'list'
   */
  variant?: "card" | "list" | "table" | undefined;
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
   * Highlight the ring color like a focus state.
   * @default false
   */
  highlight?: boolean | undefined;
  /**
   * The orientation the radio buttons are laid out.
   * @default 'vertical'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * Position of the indicator.
   * @default 'start'
   */
  indicator?: "start" | "end" | "hidden" | undefined;
  ui?:
    | {
        root?: SlotClass;
        fieldset?: SlotClass;
        legend?: SlotClass;
        item?: SlotClass;
        container?: SlotClass;
        base?: SlotClass;
        indicator?: SlotClass;
        wrapper?: SlotClass;
        label?: SlotClass;
        icon?: SlotClass;
        description?: SlotClass;
      }
    | undefined;
  /**
   * When `true`, prevents the user from interacting with radio items.
   */
  disabled?: boolean | undefined;
  /**
   * When `true`, keyboard navigation will loop from last item to first, and vice versa.
   */
  loop?: boolean | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the RadioGroup component
 */
interface RadioGroupSlots {
  legend(): any;
  label(): any;
  description(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the RadioGroup component
 */
interface RadioGroupEmits {
  update:modelValue: (payload: [value: GetItemValue<T, VK, undefined, NestedItem<T>>]) => void;
  change: (payload: [event: Event]) => void;
}
```

## Usage

Use the `v-model` directive to control the value of the RadioGroup or the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
const value = ref("System");
</script>

<template>
  <URadioGroup v-model="value" :items="items" />
</template>
```

### Items

Use the `items` prop as an array of strings or numbers:

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
const value = ref("System");
</script>

<template>
  <URadioGroup v-model="value" :items="items" />
</template>
```

You can also pass an array of objects with the following properties:

- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `description?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`value?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#value-key)
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#indicator)
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, container?: ClassNameValue, base?: ClassNameValue, 'indicator'?: ClassNameValue, wrapper?: ClassNameValue, label?: ClassNameValue, icon?: ClassNameValue, description?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
import type { RadioGroupItem } from "@nuxt/ui";

const items = ref<RadioGroupItem[]>([
  {
    label: "System",
    description: "Matches your device settings.",
    value: "system",
  },
  {
    label: "Light",
    description: "Always uses the light theme.",
    value: "light",
  },
  {
    label: "Dark",
    description: "Always uses the dark theme.",
    value: "dark",
  },
]);
const value = ref("system");
</script>

<template>
  <URadioGroup v-model="value" :items="items" />
</template>
```

> \[!CAUTION]
>
> When using objects, you need to reference the `value` property of the object in the `v-model` directive or the `default-value` prop.

### Value Key

You can change the property that is used to set the value by using the `value-key` prop. Defaults to `value`.

```vue
<script setup lang="ts">
import type { RadioGroupItem } from "@nuxt/ui";

const items = ref<RadioGroupItem[]>([
  {
    label: "System",
    description: "Matches your device settings.",
    id: "system",
  },
  {
    label: "Light",
    description: "Always uses the light theme.",
    id: "light",
  },
  {
    label: "Dark",
    description: "Always uses the dark theme.",
    id: "dark",
  },
]);
const value = ref("light");
</script>

<template>
  <URadioGroup v-model="value" value-key="id" :items="items" />
</template>
```

### Legend

Use the `legend` prop to set the legend of the RadioGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <URadioGroup legend="Theme" default-value="System" :items="items" />
</template>
```

### Color

Use the `color` prop to change the color of the RadioGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <URadioGroup color="neutral" default-value="System" :items="items" />
</template>
```

### Variant

Use the `variant` prop to change the variant of the RadioGroup.

```vue
<script setup lang="ts">
import type { RadioGroupItem } from "@nuxt/ui";

const items = ref<RadioGroupItem[]>([
  {
    label: "System",
    value: "system",
    description: "Matches your device settings.",
  },
  {
    label: "Light",
    value: "light",
    description: "Always uses the light theme.",
  },
  {
    label: "Dark",
    value: "dark",
    description: "Always uses the dark theme.",
  },
]);
</script>

<template>
  <URadioGroup
    color="primary"
    variant="card"
    default-value="system"
    :items="items"
  />
</template>
```

### Size

Use the `size` prop to change the size of the RadioGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <URadioGroup size="xl" variant="list" default-value="System" :items="items" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the RadioGroup. Defaults to `vertical`.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <URadioGroup
    orientation="horizontal"
    variant="list"
    default-value="System"
    :items="items"
  />
</template>
```

### Indicator

Use the `indicator` prop to change the position or hide the indicator. Defaults to `start`.

_(truncated — ask for fewer components to see more, or rely on the API block above)_
