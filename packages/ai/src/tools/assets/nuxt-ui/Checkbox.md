# UCheckbox

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Checkbox component
 */
interface CheckboxProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  label?: string | undefined;
  description?: string | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'list'
   */
  variant?: "card" | "list" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * Position of the indicator.
   * @default 'start'
   */
  indicator?: "start" | "end" | "hidden" | undefined;
  /**
   * Highlight the ring color like a focus state.
   * @default false
   */
  highlight?: boolean | undefined;
  /**
   * The icon displayed when checked, or above the label when `indicator` is `hidden`.
   * @default appConfig.ui.icons.check
   */
  icon?: any;
  /**
   * The icon displayed when the checkbox is indeterminate.
   * @default appConfig.ui.icons.minus
   */
  indeterminateIcon?: any;
  ui?: { root?: SlotClass; container?: SlotClass; base?: SlotClass; indicator?: SlotClass; icon?: SlotClass; wrapper?: SlotClass; label?: SlotClass; description?: SlotClass; } | undefined;
  /**
   * When `true`, prevents the user from interacting with the checkbox
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
   * The value given as data when submitted with a `name`.
   * @default "on"
   */
  value?: null | string | number | bigint | Record<string, any> | undefined;
  /**
   * Id of the element
   */
  id?: string | undefined;
  /**
   * The value of the checkbox when it is initially rendered. Use when you do not need to control its value.
   */
  defaultValue?: T | "indeterminate" | undefined;
  /**
   * The controlled value of the checkbox. Can be binded with v-model.
   */
  modelValue?: null | T | "indeterminate" | undefined;
  /**
   * The value used when the checkbox is checked. Defaults to `true`.
   */
  trueValue?: T | undefined;
  /**
   * The value used when the checkbox is unchecked. Defaults to `false`.
   */
  falseValue?: T | undefined;
  autofocus?: false | true | "true" | "false" | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
> 
> This component also supports all native `<button>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Checkbox component
 */
interface CheckboxSlots {
  label(): any;
  description(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Checkbox component
 */
interface CheckboxEmits {
  change: (payload: [event: Event]) => void;
  update:modelValue: (payload: [value: T | "indeterminate"]) => void;
}
```

## Usage

Use the `v-model` directive to control the checked state of the Checkbox.

```vue
<script setup lang="ts">
const value = ref(true)
</script>

<template>
  <UCheckbox v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <UCheckbox default-value />
</template>
```

### Indeterminate

Use the `indeterminate` value in the `v-model` directive or `default-value` prop to set the Checkbox to an [indeterminate state](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/checkbox#indeterminate_state_checkboxes).

```vue
<template>
  <UCheckbox default-value="indeterminate" />
</template>
```

### Indeterminate Icon

Use the `indeterminate-icon` prop to customize the indeterminate icon. Defaults to `i-lucide-minus`.

```vue
<template>
  <UCheckbox default-value="indeterminate" indeterminate-icon="i-lucide-plus" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.minus` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.minus` key.

### Label

Use the `label` prop to set the label of the Checkbox.

```vue
<template>
  <UCheckbox label="Check me" />
</template>
```

When using the `required` prop, an asterisk is added next to the label.

```vue
<template>
  <UCheckbox required label="Check me" />
</template>
```

### Description

Use the `description` prop to set the description of the Checkbox.

```vue
<template>
  <UCheckbox label="Check me" description="This is a checkbox." />
</template>
```

### Icon

Use the `icon` prop to set the icon of the Checkbox when it is checked. Defaults to `i-lucide-check`.

```vue
<template>
  <UCheckbox icon="i-lucide-heart" default-value label="Check me" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.check` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.check` key.

### Color

Use the `color` prop to change the color of the Checkbox.

```vue
<template>
  <UCheckbox color="neutral" default-value label="Check me" />
</template>
```

### Variant

Use the `variant` prop to change the variant of the Checkbox.

```vue
<template>
  <UCheckbox color="primary" variant="card" default-value label="Check me" />
</template>
```

### Size

Use the `size` prop to change the size of the Checkbox.

```vue
<template>
  <UCheckbox size="xl" variant="list" default-value label="Check me" />
</template>
```

### Indicator

Use the `indicator` prop to change the position or hide the indicator. Defaults to `start`.

> [!NOTE]
> 
> When `indicator` is `hidden`, the icon is displayed above the label instead.

```vue
<template>
  <UCheckbox indicator="hidden" variant="card" icon="i-lucide-heart" default-value label="Check me" />
</template>
```

### Disabled

Use the `disabled` prop to disable the Checkbox.

```vue
<template>
  <UCheckbox disabled label="Check me" />
</template>
```
