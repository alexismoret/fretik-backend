# UBadge

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Badge component
 */
interface BadgeProps {
  /**
   * The element or component this component should render as.
   * @default 'span'
   */
  as?: any;
  label?: string | number | undefined;
  /**
   * @default 'primary'
   */
  color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * @default 'solid'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * Render the badge with equal padding on all sides.
   */
  square?: boolean | undefined;
  ui?: { base?: SlotClass; label?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailingIcon?: SlotClass; } | undefined;
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
}
```

### Slots

```ts
/**
 * Slots for the Badge component
 */
interface BadgeSlots {
  leading(): any;
  default(): any;
  trailing(): any;
}
```

## Usage

Use the default slot to set the label of the Badge.

```vue
<template>
  <UBadge>
    Badge
  </UBadge>
</template>
```

### Label

Use the `label` prop to set the label of the Badge.

```vue
<template>
  <UBadge label="Badge" />
</template>
```

### Color

Use the `color` prop to change the color of the Badge.

```vue
<template>
  <UBadge color="neutral">
    Badge
  </UBadge>
</template>
```

### Variant

Use the `variant` props to change the variant of the Badge.

```vue
<template>
  <UBadge color="neutral" variant="outline">
    Badge
  </UBadge>
</template>
```

### Size

Use the `size` prop to change the size of the Badge.

```vue
<template>
  <UBadge size="xl">
    Badge
  </UBadge>
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the Badge.

```vue
<template>
  <UBadge icon="i-lucide-rocket" size="md" color="primary" variant="solid">
    Badge
  </UBadge>
</template>
```

Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

```vue
<template>
  <UBadge trailing-icon="i-lucide-arrow-right" size="md">
    Badge
  </UBadge>
</template>
```

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the Badge.

```vue
<template>
  <UBadge :avatar="{
  src: 'https://github.com/nuxt.png',
  loading: 'lazy'
}" size="md" color="neutral" variant="outline">
    Badge
  </UBadge>
</template>
```

## Examples

### `class` prop

Use the `class` prop to override the base styles of the Badge.

```vue
<template>
  <UBadge class="font-bold rounded-full">
    Badge
  </UBadge>
</template>
```
