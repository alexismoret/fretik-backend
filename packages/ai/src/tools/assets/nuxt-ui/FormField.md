# UFormField

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the FormField component
 */
interface FormFieldProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The name of the FormField. Also used to match form errors.
   */
  name?: string | undefined;
  /**
   * A regular expression to match form error names. Useful for components with array values such as InputTags, where errors include array indices in their name (e.g. `tags.0`).
   */
  errorPattern?: RegExp | undefined;
  label?: string | undefined;
  description?: string | undefined;
  help?: string | undefined;
  /**
   * @default undefined
   */
  error?: string | false | true | undefined;
  hint?: string | undefined;
  /**
   * @default 'md'
   */
  size?: "md" | "xs" | "sm" | "lg" | "xl" | undefined;
  required?: boolean | undefined;
  /**
   * If true, validation on input will be active immediately instead of waiting for a blur event.
   */
  eagerValidation?: boolean | undefined;
  /**
   * Delay in milliseconds before validating the form on input events.
   * @default `300`
   */
  validateOnInputDelay?: number | undefined;
  /**
   * The orientation of the form field.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  ui?:
    | {
        root?: SlotClass;
        wrapper?: SlotClass;
        labelWrapper?: SlotClass;
        label?: SlotClass;
        container?: SlotClass;
        description?: SlotClass;
        error?: SlotClass;
        hint?: SlotClass;
        help?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the FormField component
 */
interface FormFieldSlots {
  label(): any;
  hint(): any;
  description(): any;
  help(): any;
  error(): any;
  default(): any;
}
```

## Usage

Wrap any form component with a FormField. Used in a [Form](https://ui.nuxt.com/docs/components/form), it provides validation and error handling.

### Label

Use the `label` prop to set the label for the form control.

```vue
<template>
  <UFormField label="Email">
    <UInput placeholder="Enter your email" />
  </UFormField>
</template>
```

> \[!NOTE]
>
> The label `for` attribute and the form control are associated with a unique `id` if not provided.

When using the `required` prop, an asterisk is added next to the label.

```vue
<template>
  <UFormField label="Email" required>
    <UInput placeholder="Enter your email" />
  </UFormField>
</template>
```

### Description

Use the `description` prop to provide additional information below the label.

```vue
<template>
  <UFormField
    label="Email"
    description="We'll never share your email with anyone else."
  >
    <UInput placeholder="Enter your email" class="w-full" />
  </UFormField>
</template>
```

### Hint

Use the `hint` prop to display a hint message next to the label.

```vue
<template>
  <UFormField label="Email" hint="Optional">
    <UInput placeholder="Enter your email" />
  </UFormField>
</template>
```

### Help

Use the `help` prop to display a help message below the form control. When used together with the `error` prop, the `error` prop takes precedence.

```vue
<template>
  <UFormField label="Email" help="Please enter a valid email address.">
    <UInput placeholder="Enter your email" class="w-full" />
  </UFormField>
</template>
```

### Error

Use the `error` prop to display an error message below the form control. When used together with the `help` prop, the `error` prop takes precedence.

When used inside a [Form](https://ui.nuxt.com/docs/components/form), this is automatically set when a validation error occurs.

```vue
<template>
  <UFormField label="Email" error="Please enter a valid email address.">
    <UInput placeholder="Enter your email" class="w-full" />
  </UFormField>
</template>
```

> \[!TIP]
> See: /docs/getting-started/theme/design-system#color-system
>
> This sets the `color` to `error` on the form control. You can change it globally in your `app.config.ts`.

### Error pattern

Use the `error-pattern` prop to match form errors with a regular expression. This is especially relevant for components with array values such as [InputTags](https://ui.nuxt.com/docs/components/input-tags), where errors include array indices in their name (e.g. `tags.0`).

> \[!TIP]
> See: /docs/components/form#error-reporting
>
> See an example of using `error-pattern` within a Form.

### Size

Use the `size` prop to change the size of the FormField, the `size` is proxied to the form control.

```vue
<template>
  <UFormField
    label="Email"
    description="We'll never share your email with anyone else."
    hint="Optional"
    help="Please enter a valid email address."
    size="xl"
  >
    <UInput placeholder="Enter your email" class="w-full" />
  </UFormField>
</template>
```

### Orientation `4.3+`

Use the `orientation` prop to change the layout of the FormField. Defaults to `vertical`.

```vue
<template>
  <UFormField
    orientation="horizontal"
    label="Email"
    help="Please enter a valid email address."
    class="w-72"
  >
    <UInput placeholder="Enter your email" class="w-full" />
  </UFormField>
</template>
```
