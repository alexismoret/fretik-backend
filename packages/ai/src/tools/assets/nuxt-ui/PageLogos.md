# UPageLogos

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageLogos component
 */
interface PageLogosProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  title?: string | undefined;
  items?: PageLogosItem[] | undefined;
  /**
   * @default false
   */
  marquee?: boolean | MarqueeProps | undefined;
  ui?: { root?: SlotClass; title?: SlotClass; logos?: SlotClass; logo?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageLogos component
 */
interface PageLogosSlots {
  default(): any;
}
```

## Usage

The PageLogos component provides a flexible way to display a list of logos or images in your pages.

```vue
<template>
  <UPageLogos :items="[
  'i-simple-icons-github',
  'i-simple-icons-discord',
  'i-simple-icons-x',
  'i-simple-icons-instagram',
  'i-simple-icons-linkedin',
  'i-simple-icons-facebook'
]" />
</template>
```

### Title

Use the `title` prop to set the title above the logos.

```vue
<template>
  <UPageLogos title="Trusted by the best front-end teams" :items="[
  'i-simple-icons-github',
  'i-simple-icons-discord',
  'i-simple-icons-x',
  'i-simple-icons-instagram',
  'i-simple-icons-linkedin',
  'i-simple-icons-facebook'
]" />
</template>
```

### Items

You can display logos in two ways:

1. Using the `items` prop to provide a list of logos. Each item can be either:

- An icon name (e.g. `i-simple-icons-github`)
- An object containing `src` and `alt` properties for images, which will be utilized in a `UAvatar` component

1. Using the default slot to have complete control over the content

```vue [PageLogosWithItems.vue]
<script setup lang="ts">
const items = [
  'i-simple-icons-github',
  'i-simple-icons-discord',
  'i-simple-icons-x',
  'i-simple-icons-instagram',
  'i-simple-icons-linkedin',
  'i-simple-icons-facebook'
]
</script>

<template>
  <UPageLogos title="Trusted by the best front-end teams" :items="items" />
</template>
```

```vue [PageLogosWithSlot.vue]
<template>
  <UPageLogos title="Trusted by the best front-end teams">
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UPageLogos>
</template>
```

### Marquee

Use the `marquee` prop to enable a marquee effect for the logos.

```vue
<template>
  <UPageLogos title="Trusted by the best front-end teams" marquee :items="[
  'i-simple-icons-github',
  'i-simple-icons-discord',
  'i-simple-icons-x',
  'i-simple-icons-instagram',
  'i-simple-icons-linkedin',
  'i-simple-icons-facebook'
]" />
</template>
```

> [!NOTE]
> See: /docs/components/marquee
> 
> When you use `marquee` mode, you can customize its behavior by passing props. For more info, check out the `Marquee` component.
