# UKbd

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Kbd component
 */
interface KbdProps {
  /**
   * The element or component this component should render as.
   * @default 'kbd'
   */
  as?: any;
  value?: string | undefined;
  /**
   * @default 'neutral'
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
  variant?: "outline" | "soft" | "subtle" | "solid" | undefined;
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "lg" | undefined;
  ui?: { base?: any } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Kbd component
 */
interface KbdSlots {
  default(): any;
}
```

## Usage

Use the default slot to set the value of the Kbd.

```vue
<template>
  <UKbd> K </UKbd>
</template>
```

### Value

Use the `value` prop to set the value of the Kbd.

```vue
<template>
  <UKbd value="K" />
</template>
```

You can pass special keys to the `value` prop that goes through the [`useKbd`](https://github.com/nuxt/ui/blob/v4/src/runtime/composables/useKbd.ts){rel="&#x22;nofollow&#x22;"} composable. For example, the `meta` key displays as `⌘` on macOS and `Ctrl` on other platforms.

```vue
<template>
  <UKbd value="meta" />
</template>
```

### Color

Use the `color` prop to change the color of the Kbd.

```vue
<template>
  <UKbd color="neutral"> K </UKbd>
</template>
```

### Variant

Use the `variant` prop to change the variant of the Kbd.

```vue
<template>
  <UKbd color="neutral" variant="solid"> K </UKbd>
</template>
```

### Size

Use the `size` prop to change the size of the Kbd.

```vue
<template>
  <UKbd size="lg"> K </UKbd>
</template>
```

## Examples

### `class` prop

Use the `class` prop to override the base styles of the Badge.

```vue
<template>
  <UKbd class="font-bold rounded-full" variant="subtle"> K </UKbd>
</template>
```
