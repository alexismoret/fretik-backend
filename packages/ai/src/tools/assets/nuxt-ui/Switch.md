# USwitch

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Switch component
 */
interface SwitchProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
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
  size?: "md" | "xs" | "sm" | "lg" | "xl" | undefined;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * When `true`, the loading icon will be displayed.
   */
  loading?: boolean | undefined;
  /**
   * The icon when the `loading` prop is `true`.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
  /**
   * Display an icon when the switch is checked.
   */
  checkedIcon?: any;
  /**
   * Display an icon when the switch is unchecked.
   */
  uncheckedIcon?: any;
  label?: string | undefined;
  description?: string | undefined;
  ui?:
    | {
        root?: SlotClass;
        base?: SlotClass;
        container?: SlotClass;
        thumb?: SlotClass;
        icon?: SlotClass;
        wrapper?: SlotClass;
        label?: SlotClass;
        description?: SlotClass;
      }
    | undefined;
  /**
   * When `true`, prevents the user from interacting with the switch.
   */
  disabled?: boolean | undefined;
  id?: string | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * The value given as data when submitted with a `name`.
   */
  value?: string | undefined;
  /**
   * The state of the switch when it is initially rendered. Use when you do not need to control its state.
   */
  defaultValue?: T | undefined;
  /**
   * The controlled state of the switch. Can be bind as `v-model`.
   */
  modelValue?: null | T | undefined;
  /**
   * The value used when the switch is on. Defaults to `true`.
   */
  trueValue?: T | undefined;
  /**
   * The value used when the switch is off. Defaults to `false`.
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

> \[!NOTE]
> See: https\://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
>
> This component also supports all native `<button>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Switch component
 */
interface SwitchSlots {
  label(): any;
  description(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Switch component
 */
interface SwitchEmits {
  change: (payload: [event: Event]) => void;
  update:modelValue: (payload: [payload: T]) => void;
}
```

## Usage

Use the `v-model` directive to control the checked state of the Switch.

```vue
<script setup lang="ts">
const value = ref(true);
</script>

<template>
  <USwitch v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <USwitch default-value />
</template>
```

### Label

Use the `label` prop to set the label of the Switch.

```vue
<template>
  <USwitch label="Check me" />
</template>
```

When using the `required` prop, an asterisk is added next to the label.

```vue
<template>
  <USwitch required label="Check me" />
</template>
```

### Description

Use the `description` prop to set the description of the Switch.

```vue
<template>
  <USwitch label="Check me" description="This is a checkbox." />
</template>
```

### Icon

Use the `checked-icon` and `unchecked-icon` props to set the icons of the Switch when checked and unchecked.

```vue
<template>
  <USwitch
    unchecked-icon="i-lucide-x"
    checked-icon="i-lucide-check"
    default-value
    label="Check me"
  />
</template>
```

### Loading

Use the `loading` prop to show a loading icon on the Switch.

```vue
<template>
  <USwitch loading default-value label="Check me" />
</template>
```

### Loading Icon

Use the `loading-icon` prop to customize the loading icon. Defaults to `i-lucide-loader-circle`.

```vue
<template>
  <USwitch
    loading
    loading-icon="i-lucide-loader"
    default-value
    label="Check me"
  />
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize this icon globally in your `app.config.ts` under `ui.icons.loading` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.loading` key.

### Color

Use the `color` prop to change the color of the Switch.

```vue
<template>
  <USwitch color="neutral" default-value label="Check me" />
</template>
```

### Size

Use the `size` prop to change the size of the Switch.

```vue
<template>
  <USwitch size="xl" default-value label="Check me" />
</template>
```

### Disabled

Use the `disabled` prop to disable the Switch.

```vue
<template>
  <USwitch disabled label="Check me" />
</template>
```
