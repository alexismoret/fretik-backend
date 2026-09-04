# UAvatar

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

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

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img#attributes
> 
> This component also supports all native `<img>` HTML attributes.

## Usage

The Avatar uses the `<NuxtImg>` component when [`@nuxt/image`](https://github.com/nuxt/image) is installed, falling back to `img` otherwise.

```vue
<template>
  <UAvatar src="https://github.com/benjamincanac.png" />
</template>
```

> [!NOTE]
> 
> You can pass any property from the HTML `<img>` element such as `alt`, `loading`, etc.

> [!TIP]
> 
> To opt-out of `@nuxt/image`, use the `as` prop: `:as="{ img: 'img' }"`.

### Src

Use the `src` prop to set the image URL.

```vue
<template>
  <UAvatar src="https://github.com/benjamincanac.png" loading="lazy" />
</template>
```

### Size

Use the `size` prop to set the size of the Avatar.

```vue
<template>
  <UAvatar src="https://github.com/benjamincanac.png" size="xl" loading="lazy" />
</template>
```

> [!NOTE]
> 
> The `<img>` element's `width` and `height` are automatically set based on the `size` prop.

### Icon

Use the `icon` prop to display a fallback [Icon](https://ui.nuxt.com/docs/components/icon).

```vue
<template>
  <UAvatar icon="i-lucide-image" size="md" />
</template>
```

### Text

Use the `text` prop to display a fallback text.

```vue
<template>
  <UAvatar text="+1" size="md" />
</template>
```

### Alt

When no icon or text is provided, the **initials** of the `alt` prop is used as fallback.

```vue
<template>
  <UAvatar alt="Benjamin Canac" size="md" />
</template>
```

> [!NOTE]
> 
> The `alt` prop is passed to the `img` element as the `alt` attribute.

### Color `4.8+`

Use the `color` prop to change the color of the Avatar.

```vue
<template>
  <UAvatar color="primary" alt="Benjamin Canac" />
</template>
```

### Chip

Use the `chip` prop to display a chip around the Avatar.

```vue
<template>
  <UAvatar src="https://github.com/benjamincanac.png" loading="lazy" :chip="{
  inset: true
}" />
</template>
```

## Examples

### With tooltip

You can use a [Tooltip](https://ui.nuxt.com/docs/components/tooltip) component to display a tooltip when hovering the Avatar.

```vue [AvatarTooltipExample.vue]
<template>
  <UTooltip text="Benjamin Canac">
    <UAvatar
      src="https://github.com/benjamincanac.png"
      alt="Benjamin Canac"
      loading="lazy"
    />
  </UTooltip>
</template>
```

### With mask

You can use a CSS mask to display an Avatar with a custom shape instead of a simple circle.

```vue [AvatarMaskExample.vue]
<template>
  <UAvatar class="rounded-none squircle" src="https://avatars.githubusercontent.com/u/739984?v=4" alt="Benjamin Canac" loading="lazy" />
</template>

<style>
.squircle {
  mask-image: url("data:image/svg+xml,%3csvg width='200' height='200' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M100 0C20 0 0 20 0 100s20 100 100 100 100-20 100-100S180 0 100 0Z'/%3e%3c/svg%3e");
  mask-size: contain;
  mask-position: center;
  mask-repeat: no-repeat;
}
</style>
```
