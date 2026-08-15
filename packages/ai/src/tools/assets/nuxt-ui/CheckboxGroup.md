# UCheckboxGroup

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the CheckboxGroup component
 */
interface CheckboxGroupProps {
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
   * The controlled value of the CheckboxGroup. Can be bind as `v-model`.
   */
  modelValue?: GetItemValue<T, VK, undefined, NestedItem<T>>[] | undefined;
  /**
   * The value of the CheckboxGroup when initially rendered. Use when you do not need to control the state of the CheckboxGroup.
   */
  defaultValue?: GetItemValue<T, VK, undefined, NestedItem<T>>[] | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * @default 'list'
   */
  variant?: "table" | "list" | "card" | undefined;
  /**
   * The orientation the checkbox buttons are laid out.
   * @default 'vertical'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  ui?:
    | ({
        root?: SlotClass;
        fieldset?: SlotClass;
        legend?: SlotClass;
        item?: SlotClass;
      } & {
        root?: SlotClass;
        container?: SlotClass;
        base?: SlotClass;
        indicator?: SlotClass;
        icon?: SlotClass;
        wrapper?: SlotClass;
        label?: SlotClass;
        description?: SlotClass;
      })
    | undefined;
  /**
   * When `true`, prevents the user from interacting with the checkboxes
   */
  disabled?: boolean | undefined;
  /**
   * Whether keyboard navigation should loop around
   * @default false
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
   */
  highlight?: boolean | undefined;
  /**
   * Position of the indicator.
   * @default 'start'
   */
  indicator?: "start" | "end" | "hidden" | undefined;
  /**
   * The icon displayed when checked.
   * @default appConfig.ui.icons.check
   */
  icon?: any;
}
```

### Slots

```ts
/**
 * Slots for the CheckboxGroup component
 */
interface CheckboxGroupSlots {
  legend(): any;
  label(): any;
  description(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the CheckboxGroup component
 */
interface CheckboxGroupEmits {
  update:modelValue: (payload: [value: GetItemValue<T, VK, undefined, NestedItem<T>>[]]) => void;
  change: (payload: [event: Event]) => void;
}
```

## Usage

Use the `v-model` directive to control the value of the CheckboxGroup or the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
const value = ref(["System"]);
</script>

<template>
  <UCheckboxGroup v-model="value" :items="items" />
</template>
```

### Items

Use the `items` prop as an array of strings or numbers:

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
const value = ref(["System"]);
</script>

<template>
  <UCheckboxGroup v-model="value" :items="items" />
</template>
```

You can also pass an array of objects with the following properties:

- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `description?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`value?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#value-key)
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, container?: ClassNameValue, base?: ClassNameValue, 'indicator'?: ClassNameValue, icon?: ClassNameValue, wrapper?: ClassNameValue, label?: ClassNameValue, description?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
import type { CheckboxGroupItem } from "@nuxt/ui";

const items = ref<CheckboxGroupItem[]>([
  {
    label: "System",
    description: "This is the first option.",
    value: "system",
  },
  {
    label: "Light",
    description: "This is the second option.",
    value: "light",
  },
  {
    label: "Dark",
    description: "This is the third option.",
    value: "dark",
  },
]);
const value = ref(["system"]);
</script>

<template>
  <UCheckboxGroup v-model="value" :items="items" />
</template>
```

> \[!CAUTION]
>
> When using objects, you need to reference the `value` property of the object in the `v-model` directive or the `default-value` prop.

### Value Key

You can change the property that is used to set the value by using the `value-key` prop. Defaults to `value`.

```vue
<script setup lang="ts">
import type { CheckboxGroupItem } from "@nuxt/ui";

const items = ref<CheckboxGroupItem[]>([
  {
    label: "System",
    description: "This is the first option.",
    id: "system",
  },
  {
    label: "Light",
    description: "This is the second option.",
    id: "light",
  },
  {
    label: "Dark",
    description: "This is the third option.",
    id: "dark",
  },
]);
const value = ref(["light"]);
</script>

<template>
  <UCheckboxGroup v-model="value" value-key="id" :items="items" />
</template>
```

### Legend

Use the `legend` prop to set the legend of the CheckboxGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <UCheckboxGroup legend="Theme" :default-value="['System']" :items="items" />
</template>
```

### Color

Use the `color` prop to change the color of the CheckboxGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <UCheckboxGroup color="neutral" :default-value="['System']" :items="items" />
</template>
```

### Variant

Use the `variant` prop to change the variant of the CheckboxGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <UCheckboxGroup
    color="primary"
    variant="card"
    :default-value="['System']"
    :items="items"
  />
</template>
```

### Size

Use the `size` prop to change the size of the CheckboxGroup.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <UCheckboxGroup
    size="xl"
    variant="list"
    :default-value="['System']"
    :items="items"
  />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the CheckboxGroup. Defaults to `vertical`.

```vue
<script setup lang="ts">
const items = ref(["System", "Light", "Dark"]);
</script>

<template>
  <UCheckboxGroup
    orientation="horizontal"
    variant="list"
    :default-value="['System']"
    :items="items"
  />
</template>
```

### Indicator

_(truncated — ask for fewer components to see more, or rely on the API block above)_
