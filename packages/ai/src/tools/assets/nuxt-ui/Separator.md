# USeparator

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Separator component
 */
interface SeparatorProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Display a label on the separator.
   */
  label?: string | undefined;
  /**
   * Display an icon on the separator.
   */
  icon?: any;
  /**
   * Display an avatar on the separator.
   */
  avatar?: AvatarProps | undefined;
  /**
   * @default 'neutral'
   */
  color?:
    | "error"
    | "neutral"
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | undefined;
  /**
   * @default 'xs'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * @default 'solid'
   */
  type?: "solid" | "dashed" | "dotted" | undefined;
  /**
   * The orientation of the separator.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * The position of the content.
   * @default 'center'
   */
  position?: "center" | "start" | "end" | undefined;
  ui?:
    | {
        root?: SlotClass;
        border?: SlotClass;
        container?: SlotClass;
        icon?: SlotClass;
        avatar?: SlotClass;
        avatarSize?: SlotClass;
        label?: SlotClass;
      }
    | undefined;
  /**
   * Whether or not the component is purely decorative. <br>When `true`, accessibility-related attributes
   * are updated so that that the rendered element is removed from the accessibility tree.
   */
  decorative?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Separator component
 */
interface SeparatorSlots {
  default(): any;
}
```

## Usage

Use the Separator component as-is to separate content.

```vue
<template>
  <USeparator />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the Separator. Defaults to `horizontal`.

```vue
<template>
  <USeparator orientation="vertical" class="h-48" />
</template>
```

### Label

Use the `label` prop to display a label in the middle of the Separator.

```vue
<template>
  <USeparator label="Hello World" />
</template>
```

### Position `4.8+`

Use the `position` prop to change the position of the content of the Separator. Defaults to `center`.

```vue
<template>
  <USeparator position="start" label="Hello World" />
</template>
```

### Icon

Use the `icon` prop to display an icon in the middle of the Separator.

```vue
<template>
  <USeparator icon="i-simple-icons-nuxtdotjs" />
</template>
```

### Avatar

Use the `avatar` prop to display an avatar in the middle of the Separator.

```vue
<template>
  <USeparator
    :avatar="{
      src: 'https://github.com/nuxt.png',
      loading: 'lazy',
    }"
  />
</template>
```

### Color

Use the `color` prop to change the color of the Separator. Defaults to `neutral`.

```vue
<template>
  <USeparator color="primary" type="solid" />
</template>
```

### Type

Use the `type` prop to change the type of the Separator. Defaults to `solid`.

```vue
<template>
  <USeparator type="dashed" />
</template>
```

### Size

Use the `size` prop to change the size of the Separator. Defaults to `xs`.

```vue
<template>
  <USeparator size="lg" />
</template>
```
