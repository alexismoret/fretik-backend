# UUser

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the User component
 */
interface UserProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  name?: string | undefined;
  description?: string | undefined;
  avatar?: Omit<AvatarProps, "size"> & { [key: string]: any; } | undefined;
  chip?: boolean | Omit<ChipProps, "size" | "inset"> | undefined;
  /**
   * @default 'md'
   */
  size?: "md" | "3xs" | "2xs" | "xs" | "sm" | "lg" | "xl" | "2xl" | "3xl" | undefined;
  /**
   * The orientation of the user.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  to?: string | it | et | undefined;
  target?: null | "_blank" | "_parent" | "_self" | "_top" | string & {} | undefined;
  onClick?: (event: MouseEvent): void | undefined;
  ui?: { root?: SlotClass; wrapper?: SlotClass; name?: SlotClass; description?: SlotClass; avatar?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the User component
 */
interface UserSlots {
  avatar(): any;
  name(): any;
  description(): any;
  default(): any;
}
```

## Composition

Parts placed by name: `#avatar`, `#name`.

## Usage

### Name

Use the `name` prop to display a name for the user.

```vue
<template>
  <UUser name="John Doe" />
</template>
```

### Description

Use the `description` prop to display a description for the user.

```vue
<template>
  <UUser name="John Doe" description="Software Engineer" />
</template>
```

### Avatar

Use the `avatar` prop to display an [Avatar](https://ui.nuxt.com/docs/components/avatar) component.

```vue
<template>
  <UUser name="John Doe" description="Software Engineer" :avatar="{
  src: 'https://i.pravatar.cc/150?u=john-doe',
  loading: 'lazy',
  icon: 'i-lucide-image'
}" />
</template>
```

```ts
/**
 * Props for the Avatar component
 */
interface AvatarProps {
  /**
   * The element or component this component should render as.
   * @default 'span'
   */
  as?: any;
  src?: string | undefined;
  alt?: string | undefined;
  icon?: any;
  text?: string | undefined;
  /**
   * @default 'md'
   */
  size?: "md" | "xs" | "sm" | "lg" | "xl" | "3xs" | "2xs" | "2xl" | "3xl" | undefined;
  /**
   * @default 'neutral'
   */
  color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  chip?: boolean | ChipProps | undefined;
  ui?: { root?: SlotClass; image?: SlotClass; fallback?: SlotClass; icon?: SlotClass; } | undefined;
  loading?: "lazy" | "eager" | undefined;
  referrerpolicy?: "" | "no-referrer" | "no-referrer-when-downgrade" | "origin" | "origin-when-cross-origin" | "same-origin" | "strict-origin" | "strict-origin-when-cross-origin" | "unsafe-url" | undefined;
  decoding?: "async" | "auto" | "sync" | undefined;
  height?: string | number | undefined;
  sizes?: string | undefined;
  srcset?: string | undefined;
  usemap?: string | undefined;
  width?: string | number | undefined;
  crossorigin?: "anonymous" | "use-credentials" | undefined;
}
```

### Chip

Use the `chip` prop to display a [Chip](https://ui.nuxt.com/docs/components/chip) component.

```vue
<template>
  <UUser name="John Doe" description="Software Engineer" :avatar="{
  src: 'https://i.pravatar.cc/150?u=john-doe'
}" :chip="{
  color: 'primary',
  position: 'top-right'
}" />
</template>
```

```ts
/**
 * Props for the Chip component
 */
interface ChipProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Display some text inside the chip.
   */
  text?: string | number | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "3xs" | "2xs" | "2xl" | "3xl" | undefined;
  /**
   * The position of the chip.
   * @default 'top-right'
   */
  position?: "top-right" | "bottom-right" | "top-left" | "bottom-left" | undefined;
  /**
   * When `true`, keep the chip inside the component for rounded elements.
   * @default false
   */
  inset?: boolean | undefined;
  /**
   * When `true`, render the chip relatively to the parent.
   * @default false
   */
  standalone?: boolean | undefined;
  ui?: { root?: SlotClass; base?: SlotClass; } | undefined;
  /**
   * @default true
   */
  show?: boolean | undefined;
}
```

### Size

Use the `size` prop to change the size of the user avatar and text.

```vue
<template>
  <UUser name="John Doe" description="Software Engineer" :avatar="{
  src: 'https://i.pravatar.cc/150?u=john-doe'
}" chip size="xl" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation. Defaults to `horizontal`.

```vue
<template>
  <UUser orientation="vertical" name="John Doe" description="Software Engineer" :avatar="{
  src: 'https://i.pravatar.cc/150?u=john-doe'
}" />
</template>
```

### Link

You can pass any property from the [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link) component such as `to`, `target`, `rel`, etc.

```vue
<template>
  <UUser to="https://github.com/benjamincanac" target="_blank" name="Benjamin Canac" description="Software Engineer" :avatar="{
  src: 'https://github.com/benjamincanac.png'
}" />
</template>
```

> [!NOTE]
> 
> The `NuxtLink` component will inherit all other attributes you pass to the `User` component.
