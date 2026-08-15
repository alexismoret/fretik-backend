# UPinInput

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PinInput component
 */
interface PinInputProps {
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
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "ghost" | "none" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * The number of input fields.
   * @default 5
   */
  length?: string | number | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  /**
   * Group inputs by inserting a separator between them.
   * Pass a number to insert one after every Nth input, or an array of positions to insert after specific inputs.
   */
  separator?: number | number[] | undefined;
  ui?:
    { root?: SlotClass; base?: SlotClass; separator?: SlotClass } | undefined;
  /**
   * The default value of the pin inputs when it is initially rendered. Use when you do not need to control its checked state.
   */
  defaultValue?: PinInputValue<T> | undefined;
  /**
   * When `true`, prevents the user from interacting with the pin input
   */
  disabled?: boolean | undefined;
  /**
   * Id of the element
   */
  id?: string | undefined;
  /**
   * When `true`, pin inputs will be treated as password.
   */
  mask?: boolean | undefined;
  /**
   * The controlled checked state of the pin input. Can be binded as `v-model`.
   */
  modelValue?: null | PinInputValue<T> | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, mobile devices will autodetect the OTP from messages or clipboard, and enable the autocomplete field.
   */
  otp?: boolean | undefined;
  /**
   * The placeholder character to use for empty pin-inputs.
   */
  placeholder?: string | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * Input type for the inputs.
   * @default 'text'
   */
  type?: T | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PinInput component
 */
interface PinInputSlots {
  separator(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the PinInput component
 */
interface PinInputEmits {
  update:modelValue: (payload: [value: PinInputValue<T>]) => void;
  complete: (payload: [value: PinInputValue<T>]) => void;
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: Event]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name                                                                                                                            | Type                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputsRef`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<ComponentPublicInstance[]>`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |

## Usage

Use the `v-model` directive to control the value of the PinInput.

```vue
<script setup lang="ts">
const value = ref([]);
</script>

<template>
  <UPinInput v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <UPinInput :default-value="['1', '2', '3']" />
</template>
```

### Type

Use the `type` prop to change the input type. Defaults to `text`.

```vue
<template>
  <UPinInput type="number" />
</template>
```

> \[!NOTE]
>
> When `type` is set to `number`, it will only accept numeric characters.

### Mask

Use the `mask` prop to treat the input like a password.

```vue
<template>
  <UPinInput mask :default-value="['1', '2', '3', '4', '5']" />
</template>
```

### OTP

Use the `otp` prop to enable One-Time Password functionality. When enabled, mobile devices can automatically detect and fill OTP codes from SMS messages or clipboard content, with autocomplete support.

```vue
<template>
  <UPinInput otp />
</template>
```

### Placeholder

Use the `placeholder` prop to set a placeholder text.

```vue
<template>
  <UPinInput placeholder="○" />
</template>
```

### Length

Use the `length` prop to change the amount of inputs.

```vue
<template>
  <UPinInput :length="6" placeholder="○" />
</template>
```

### Separator `4.9+`

Use the `separator` prop to insert a separator between groups of inputs. Pass a number to insert one after every Nth input.

```vue
<template>
  <UPinInput :length="6" :separator="3" placeholder="○" />
</template>
```

You can also pass an array of positions to insert separators after specific inputs.

```vue
<template>
  <UPinInput :length="7" :separator="[3, 4]" placeholder="○" />
</template>
```

### Color

Use the `color` prop to change the ring color when the PinInput is focused.

```vue
<template>
  <UPinInput color="neutral" highlight placeholder="○" />
</template>
```

> \[!NOTE]
>
> The `highlight` prop is used here to show the focus state. It's used internally when a validation error occurs.

### Variant

Use the `variant` prop to change the variant of the PinInput.

```vue
<template>
  <UPinInput
    color="neutral"
    variant="subtle"
    :highlight="false"
    placeholder="○"
  />
</template>
```

### Size

Use the `size` prop to change the size of the PinInput.

```vue
<template>
  <UPinInput size="xl" placeholder="○" />
</template>
```

### Disabled

Use the `disabled` prop to disable the PinInput.

```vue
<template>
  <UPinInput disabled placeholder="○" />
</template>
```

## Examples

### With separator slot `4.9+`

Use the `separator` slot to customize the separator appearance.

```vue [PinInputSeparatorSlotExample.vue]
<template>
  <UPinInput :length="6" :separator="3" placeholder="○">
    <template #separator>
      <UIcon name="i-lucide-minus" class="size-4" />
    </template>
  </UPinInput>
</template>
```
