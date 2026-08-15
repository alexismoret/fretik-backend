# UInputNumber

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the InputNumber component
 */
interface InputNumberProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The placeholder text when the input is empty.
   */
  placeholder?: string | undefined;
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
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  /**
   * The orientation of the input number.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * Configure the increment button. The `color` and `size` are inherited.
   * @default true
   */
  increment?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed to increment the value.
   * @default appConfig.ui.icons.plus
   */
  incrementIcon?: any;
  /**
   * Disable the increment button.
   */
  incrementDisabled?: boolean | undefined;
  /**
   * Configure the decrement button. The `color` and `size` are inherited.
   * @default true
   */
  decrement?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed to decrement the value.
   * @default appConfig.ui.icons.minus
   */
  decrementIcon?: any;
  /**
   * Disable the decrement button.
   */
  decrementDisabled?: boolean | undefined;
  autofocus?: boolean | undefined;
  autofocusDelay?: number | undefined;
  defaultValue?: NonNullable<T> | undefined;
  modelValue?: T | Mod extends { optional: true }
    ? undefined
    : never | undefined;
  modelModifiers?: Mod | undefined;
  ui?:
    | {
        root?: SlotClass;
        base?: SlotClass;
        increment?: SlotClass;
        decrement?: SlotClass;
      }
    | undefined;
  /**
   * The smallest value allowed for the input.
   */
  min?: number | undefined;
  /**
   * The largest value allowed for the input.
   */
  max?: number | undefined;
  /**
   * The amount that the input value changes with each increment or decrement "tick".
   */
  step?: number | undefined;
  /**
   * When `false`, prevents the value from snapping to the nearest increment of the step value
   */
  stepSnapping?: boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with the Number Field.
   */
  disabled?: boolean | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * Id of the element
   */
  id?: string | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * Formatting options for the value displayed in the number field. This also affects what characters are allowed to be typed by the user.
   */
  formatOptions?: Intl.NumberFormatOptions | undefined;
  /**
   * When `true`, prevents the value from changing on wheel scroll.
   */
  disableWheelChange?: boolean | undefined;
  /**
   * When `true`, inverts the direction of the wheel change.
   */
  invertWheelChange?: boolean | undefined;
  /**
   * When `true`, the Number Field is read-only.
   */
  readonly?: boolean | undefined;
  /**
   * When `true`, the input will be focused when the value changes.
   */
  focusOnChange?: boolean | undefined;
  /**
   * The locale to use for formatting and currencies
   */
  locale?: string | undefined;
  enterKeyHint?:
    | "enter"
    | "done"
    | "go"
    | "next"
    | "previous"
    | "search"
    | "send"
    | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  list?: string | undefined;
  autocomplete?: "on" | "off" | (string & {}) | undefined;
}
```

> \[!NOTE]
> See: https\://developer.mozilla.org/en-US/docs/Web/HTML/Element/input#attributes
>
> This component also supports all native `<input>` HTML attributes.

### Slots

```ts
/**
 * Slots for the InputNumber component
 */
interface InputNumberSlots {
  increment(): any;
  decrement(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the InputNumber component
 */
interface InputNumberEmits {
  update:modelValue: (payload: [value: ApplyModifiers<T, Mod>]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  change: (payload: [event: Event]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name                                                                                                                           | Type                  |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `inputRef`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<HTMLInputElement | null>`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |

## Usage

Use the `v-model` directive to control the value of the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <UInputNumber :default-value="5" />
</template>
```

> \[!NOTE]
>
> This component relies on the [`@internationalized/number`](https://react-spectrum.adobe.com/internationalized/number/index.html){rel="&#x22;nofollow&#x22;"} package which provides utilities for formatting and parsing numbers across locales and numbering systems.

### Min / Max

Use the `min` and `max` props to set the minimum and maximum values of the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" :min="0" :max="10" />
</template>
```

### Step

Use the `step` prop to set the step value of the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" :step="2" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" orientation="vertical" />
</template>
```

### Placeholder

Use the `placeholder` prop to set a placeholder text.

```vue
<template>
  <UInputNumber placeholder="Enter a number" />
</template>
```

### Color

Use the `color` prop to change the ring color when the InputNumber is focused.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" color="neutral" highlight />
</template>
```

### Variant

Use the `variant` prop to change the variant of the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber
    v-model="value"
    variant="subtle"
    color="neutral"
    :highlight="false"
  />
</template>
```

### Size

Use the `size` prop to change the size of the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" size="xl" />
</template>
```

### Disabled

Use the `disabled` prop to disable the InputNumber.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" disabled />
</template>
```

### Increment / Decrement

Use the `increment` and `decrement` props to customize the increment and decrement buttons with any [Button](https://ui.nuxt.com/docs/components/button) props. Defaults to `{ variant: 'link' }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber
    v-model="value"
    :increment="{
      color: 'neutral',
      variant: 'solid',
      size: 'xs',
    }"
    :decrement="{
      color: 'neutral',
      variant: 'solid',
      size: 'xs',
    }"
  />
</template>
```

### Increment / Decrement Icons

Use the `increment-icon` and `decrement-icon` props to customize the buttons [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-plus` / `i-lucide-minus`.

```vue
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber
    v-model="value"
    increment-icon="i-lucide-arrow-right"
    decrement-icon="i-lucide-arrow-left"
  />
</template>
```

## Examples

### With decimal format

Use the `format-options` prop to customize the format of the value.

```vue [InputNumberDecimalExample.vue]
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber
    v-model="value"
    :format-options="{
      signDisplay: 'exceptZero',
      minimumFractionDigits: 1,
    }"
  />
</template>
```

### With percentage format

Use the `format-options` prop with `style: 'percent'` to customize the format of the value.

```vue [InputNumberPercentageExample.vue]
<script setup lang="ts">
const value = ref(0.05);
</script>

<template>
  <UInputNumber
    v-model="value"
    :step="0.01"
    :format-options="{
      style: 'percent',
    }"
  />
</template>
```

### With currency format

Use the `format-options` prop with `style: 'currency'` to customize the format of the value.

```vue [InputNumberCurrencyExample.vue]
<script setup lang="ts">
const value = ref(1500);
</script>

<template>
  <UInputNumber
    v-model="value"
    :format-options="{
      style: 'currency',
      currency: 'EUR',
      currencyDisplay: 'code',
      currencySign: 'accounting',
    }"
  />
</template>
```

### Without buttons

You can use the `increment` and `decrement` props to control visibility of the buttons.

```vue [InputNumberWithoutButtonsExample.vue]
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value" :increment="false" :decrement="false" />
</template>
```

### Within a FormField

You can use the InputNumber within a [FormField](https://ui.nuxt.com/docs/components/form-field) component to display a label, help text, required indicator, etc.

```vue [InputNumberFormFieldExample.vue]
<script setup lang="ts">
const retries = ref(0);
</script>

<template>
  <UFormField label="Retries" help="Specify number of attempts" required>
    <UInputNumber v-model="retries" placeholder="Enter retries" />
  </UFormField>
</template>
```

### With slots

Use the `#increment` and `#decrement` slots to customize the buttons.

```vue [InputNumberSlotsExample.vue]
<script setup lang="ts">
const value = ref(5);
</script>

<template>
  <UInputNumber v-model="value">
    <template #decrement>
      <UButton size="xs" icon="i-lucide-minus" />
    </template>

    <template #increment>
      <UButton size="xs" icon="i-lucide-plus" />
    </template>
  </UInputNumber>
</template>
```
