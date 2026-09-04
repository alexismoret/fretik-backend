# UInputTags

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the InputTags component
 */
interface InputTagsProps {
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
   * The maximum number of character allowed.
   */
  maxLength?: number | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "ghost" | "none" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  /**
   * The icon displayed to delete a tag.
   * @default appConfig.ui.icons.close
   */
  deleteIcon?: any;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  ui?: { root?: SlotClass; base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; item?: SlotClass; itemText?: SlotClass; itemDelete?: SlotClass; itemDeleteIcon?: SlotClass; input?: SlotClass; } | undefined;
  /**
   * The controlled value of the tags input. Can be bind as `v-model`.
   */
  modelValue?: null | T[] | undefined;
  /**
   * The value of the tags that should be added. Use when you do not need to control the state of the tags input
   */
  defaultValue?: T[] | undefined;
  /**
   * When `true`, allow adding tags on paste. Work in conjunction with delimiter prop.
   */
  addOnPaste?: boolean | undefined;
  /**
   * When `true` allow adding tags on tab keydown
   */
  addOnTab?: boolean | undefined;
  /**
   * When `true` allow adding tags blur input
   */
  addOnBlur?: boolean | undefined;
  /**
   * When `true`, allow duplicated tags.
   */
  duplicate?: boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with the tags input.
   */
  disabled?: boolean | undefined;
  /**
   * The character or regular expression to trigger the addition of a new tag. Also used to split tags for `@paste` event
   */
  delimiter?: string | RegExp | undefined;
  /**
   * Maximum number of tags.
   */
  max?: number | undefined;
  id?: string | undefined;
  /**
   * Convert the input value to the desired type. Mandatory when using objects as values and using `TagsInputInput`
   */
  convertValue?: (value: string): T | undefined;
  /**
   * Display the value of the tag. Useful when you want to apply modifications to the value like adding a suffix or when using object as values
   */
  displayValue?: (value: T): string | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * Display an icon based on the `leading` and `trailing` props.
   */
  icon?: any;
  /**
   * Display an avatar on the left side.
   */
  avatar?: AvatarProps | undefined;
  /**
   * When `true`, the icon will be displayed on the left side.
   */
  leading?: boolean | undefined;
  /**
   * Display an icon on the left side.
   */
  leadingIcon?: any;
  /**
   * When `true`, the icon will be displayed on the right side.
   */
  trailing?: boolean | undefined;
  /**
   * Display an icon on the right side.
   */
  trailingIcon?: any;
  /**
   * When `true`, the loading icon will be displayed.
   */
  loading?: boolean | undefined;
  /**
   * The icon when the `loading` prop is `true`.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
  enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send" | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  list?: string | undefined;
  readonly?: false | true | "true" | "false" | undefined;
  autocomplete?: "on" | "off" | string & {} | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input#attributes
> 
> This component also supports all native `<input>` HTML attributes.

### Slots

```ts
/**
 * Slots for the InputTags component
 */
interface InputTagsSlots {
  leading(): any;
  default(): any;
  trailing(): any;
  item-text(): any;
  item-delete(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the InputTags component
 */
interface InputTagsEmits {
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  focus: (payload: [event: FocusEvent]) => void;
  update:modelValue: (payload: [payload: T[]]) => void;
  invalid: (payload: [payload: T]) => void;
  addTag: (payload: [payload: T]) => void;
  removeTag: (payload: [payload: T]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `inputRef` | `Ref<HTMLInputElement \| null>` |

## Composition

Parts placed by name: `#item-text`, `#item-delete`.

## Usage

Use the `v-model` directive to control the value of the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <UInputTags :default-value="[
  'Vue'
]" />
</template>
```

### Placeholder

Use the `placeholder` prop to set a placeholder text.

```vue
<template>
  <UInputTags placeholder="Enter tags..." />
</template>
```

### Max Length

Use the `max-length` prop to set the maximum number of characters allowed in a tag.

```vue
<template>
  <UInputTags :max-length="4" />
</template>
```

### Color

Use the `color` prop to change the ring color when the InputTags is focused.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" color="neutral" highlight />
</template>
```

> [!NOTE]
> 
> The `highlight` prop is used here to show the focus state. It's used internally when a validation error occurs.

### Variants

Use the `variant` prop to change the appearance of the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" variant="subtle" color="neutral" :highlight="false" />
</template>
```

### Sizes

Use the `size` prop to adjust the size of the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" size="xl" />
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" icon="i-lucide-search" size="md" variant="outline" />
</template>
```

> [!NOTE]
> 
> Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" :avatar="{
  src: 'https://github.com/vuejs.png',
  loading: 'lazy'
}" size="md" variant="outline" />
</template>
```

### Delete Icon

Use the `delete-icon` prop to customize the delete [Icon](https://ui.nuxt.com/docs/components/icon) in the tags. Defaults to `i-lucide-x`.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" delete-icon="i-lucide-trash" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.close` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.close` key.

### Loading

Use the `loading` prop to show a loading icon on the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" loading :trailing="false" />
</template>
```

### Loading Icon

Use the `loading-icon` prop to customize the loading icon. Defaults to `i-lucide-loader-circle`.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" loading loading-icon="i-lucide-loader" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.loading` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.loading` key.

### Disabled

Use the `disabled` prop to disable the InputTags.

```vue
<script setup lang="ts">
const value = ref([
  "Vue"
])
</script>

<template>
  <UInputTags v-model="value" disabled />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Within a FormField

You can use the InputTags within a [FormField](https://ui.nuxt.com/docs/components/form-field) component to display a label, help text, required indicator, etc.

```vue [InputTagsFormFieldExample.vue]
<script setup lang="ts">
const tags = ref(['Vue'])
</script>

<template>
  <UFormField label="Tags" required>
    <UInputTags v-model="tags" placeholder="Enter tags..." />
  </UFormField>
</template>
```
