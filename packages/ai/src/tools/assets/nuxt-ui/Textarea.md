# UTextarea

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Textarea component
 */
interface TextareaProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  id?: string | undefined;
  name?: string | undefined;
  /**
   * The placeholder text when the textarea is empty.
   */
  placeholder?: string | undefined;
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
  required?: boolean | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  autoresize?: boolean | undefined;
  /**
   * @default 0
   */
  autoresizeDelay?: number | undefined;
  disabled?: boolean | undefined;
  /**
   * @default 3
   */
  rows?: number | undefined;
  /**
   * @default 0
   */
  maxrows?: number | undefined;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  defaultValue?: _Number<_Optional<_Nullable<T, Mod>, Mod>, Mod> | undefined;
  modelValue?: _Number<_Optional<_Nullable<T, Mod>, Mod>, Mod> | undefined;
  modelModifiers?: Mod | undefined;
  ui?: { root?: SlotClass; base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; } | undefined;
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
  autocomplete?: string | undefined;
  cols?: string | number | undefined;
  dirname?: string | undefined;
  form?: string | undefined;
  maxlength?: string | number | undefined;
  minlength?: string | number | undefined;
  readonly?: false | true | "true" | "false" | undefined;
  wrap?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/textarea#attributes
> 
> This component also supports all native `<textarea>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Textarea component
 */
interface TextareaSlots {
  leading(): any;
  default(): any;
  trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Textarea component
 */
interface TextareaEmits {
  update:modelValue: (payload: [value: _Number<_Optional<_Nullable<T, Mod>, Mod>, Mod>]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  change: (payload: [event: Event]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `textareaRef` | `Ref<HTMLTextAreaElement \| null>` |
| `autoResize` | `() => void` |

## Usage

Use the `v-model` directive to control the value of the Textarea.

```vue
<script setup lang="ts">
const value = ref("")
</script>

<template>
  <UTextarea />
</template>
```

### Rows

Use the `rows` prop to set the number of rows. Defaults to `3`.

```vue
<template>
  <UTextarea :rows="12" />
</template>
```

### Placeholder

Use the `placeholder` prop to set a placeholder text.

```vue
<template>
  <UTextarea placeholder="Type something..." />
</template>
```

### Autoresize

Use the `autoresize` prop to enable autoresizing the height of the Textarea.

```vue
<script setup lang="ts">
const value = ref("This is a long text that will autoresize the height of the Textarea.")
</script>

<template>
  <UTextarea v-model="value" autoresize />
</template>
```

Use the `maxrows` prop to set the maximum number of rows when autoresizing. If set to `0`, the Textarea will grow indefinitely.

```vue
<script setup lang="ts">
const value = ref("This is a long text that will autoresize the height of the Textarea with a maximum of 4 rows.")
</script>

<template>
  <UTextarea v-model="value" :maxrows="4" autoresize />
</template>
```

### Color

Use the `color` prop to change the ring color when the Textarea is focused.

```vue
<template>
  <UTextarea color="neutral" highlight placeholder="Type something..." />
</template>
```

> [!NOTE]
> 
> The `highlight` prop is used here to show the focus state. It's used internally when a validation error occurs.

### Variant

Use the `variant` prop to change the variant of the Textarea.

```vue
<template>
  <UTextarea color="neutral" variant="subtle" :highlight="false" placeholder="Type something..." />
</template>
```

### Size

Use the `size` prop to change the size of the Textarea.

```vue
<template>
  <UTextarea size="xl" placeholder="Type something..." />
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the Textarea.

```vue
<template>
  <UTextarea icon="i-lucide-search" size="md" variant="outline" placeholder="Search..." :rows="1" />
</template>
```

Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

```vue
<template>
  <UTextarea trailing-icon="i-lucide-at-sign" placeholder="Enter your email" size="md" :rows="1" />
</template>
```

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the Textarea.

```vue
<template>
  <UTextarea :avatar="{
  src: 'https://github.com/nuxt.png',
  loading: 'lazy'
}" size="md" variant="outline" placeholder="Search..." :rows="1" />
</template>
```

### Loading

Use the `loading` prop to show a loading icon on the Textarea.

```vue
<template>
  <UTextarea loading :trailing="false" placeholder="Search..." :rows="1" />
</template>
```

### Loading Icon

Use the `loading-icon` prop to customize the loading icon. Defaults to `i-lucide-loader-circle`.

```vue
<template>
  <UTextarea loading loading-icon="i-lucide-loader" placeholder="Search..." :rows="1" />
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

Use the `disabled` prop to disable the Textarea.

```vue
<template>
  <UTextarea disabled placeholder="Type something..." />
</template>
```
