# UPageCard

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageCard component
 */
interface PageCardProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The icon displayed above the title.
   */
  icon?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The orientation of the page card.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * Reverse the order of the default slot.
   * @default false
   */
  reverse?: boolean | undefined;
  /**
   * Display a line around the page card.
   */
  highlight?: boolean | undefined;
  /**
   * @default 'primary'
   */
  highlightColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * Display a spotlight effect that follows your mouse cursor and highlights borders on hover.
   */
  spotlight?: boolean | undefined;
  /**
   * @default 'primary'
   */
  spotlightColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | "ghost" | "naked" | undefined;
  to?: string | it | et | undefined;
  target?: null | "_blank" | "_parent" | "_self" | "_top" | string & {} | undefined;
  onClick?: (event: MouseEvent): void | undefined;
  ui?: { root?: SlotClass; spotlight?: SlotClass; container?: SlotClass; wrapper?: SlotClass; header?: SlotClass; body?: SlotClass; footer?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; title?: SlotClass; description?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageCard component
 */
interface PageCardSlots {
  header(): any;
  body(): any;
  leading(): any;
  title(): any;
  description(): any;
  footer(): any;
  default(): any;
}
```

## Usage

The PageCard component provides a flexible way to display content in a card with an illustration in the default slot.

```vue
<template>
  <u-page-card description=Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements. icon=i-simple-icons-tailwindcss title=Tailwind CSS>
  <img alt=Tailwind CSS src=/tailwindcss-v4.svg /></u-page-card>
</template>
```

> \[!TIP]
>
> Use the [PageGrid](https://ui.nuxt.com/docs/components/page-grid), [PageColumns](https://ui.nuxt.com/docs/components/page-columns) or [PageList](https://ui.nuxt.com/docs/components/page-list) components to display multiple PageCard.

### Title

Use the `title` prop to set the title of the card.

```vue
<template>
  <UPageCard title="Tailwind CSS" />
</template>
```

### Description

Use the `description` prop to set the description of the card.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
  />
</template>
```

### Icon

Use the `icon` prop to set the icon of the card.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
  />
</template>
```

### Link

You can pass any property from the [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link){rel="&#x22;nofollow&#x22;"} component such as `to`, `target`, `rel`, etc.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
    to="https://tailwindcss.com/blog/tailwindcss-v4"
    target="_blank"
  />
</template>
```

### Variant

Use the `variant` prop to change the style of the card.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
    to="https://tailwindcss.com/blog/tailwindcss-v4"
    target="_blank"
    variant="soft"
  />
</template>
```

> \[!TIP]
>
> You can apply the `light` or `dark` class to the `links` slot when using the `solid` variant to reverse the colors.

### Orientation

Use the `orientation` prop to change the orientation with the default slot. Defaults to `vertical`.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
    orientation="horizontal"
  >
    <img src="/tailwindcss-v4.svg" alt="Tailwind CSS" class="w-full" />
  </UPageCard>
</template>
```

### Reverse

Use the `reverse` prop to reverse the orientation of the default slot.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
    orientation="horizontal"
    reverse
  >
    <img src="/tailwindcss-v4.svg" alt="Tailwind CSS" class="w-full" />
  </UPageCard>
</template>
```

### Highlight

Use the `highlight` and `highlight-color` props to display a highlighted border around the card.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
    orientation="horizontal"
    highlight
    highlight-color="primary"
  >
    <img src="/tailwindcss-v4.svg" alt="Tailwind CSS" class="w-full" />
  </UPageCard>
</template>
```

### Spotlight

Use the `spotlight` and `spotlight-color` props to display a spotlight effect that follows your mouse cursor and highlights borders on hover.

> \[!NOTE]
>
> The spotlight effect will take over hover effects when using a `to` prop. It's best to use it with the `outline` variant.

```vue
<template>
  <UPageCard
    title="Tailwind CSS"
    description="Nuxt UI integrates with latest Tailwind CSS, bringing significant improvements."
    icon="i-simple-icons-tailwindcss"
    orientation="horizontal"
    spotlight
    spotlight-color="primary"
  >
    <img src="/tailwindcss-v4.svg" alt="Tailwind CSS" class="w-full" />
  </UPageCard>
</template>
```

> \[!TIP]
>
> You can also customize the color and size by using the `--spotlight-color` and `--spotlight-size` CSS variables:
>
> ```vue
> <template>
>   <UPageCard
>     spotlight
>     class="[--spotlight-color:var(--ui-error)] [--spotlight-size:200px]"
>   />
> </template>
> ```

## Examples

### As a testimonial

Use the [User](https://ui.nuxt.com/docs/components/user) component in the `header` or `footer` slot to make the card look like a testimonial.

```vue [PageCardTestimonialExample.vue]
<script setup lang="ts">
const testimonial = ref({
  user: {
    name: "Evan You",
    description: "Author of Vue.js and Vite",
    avatar: {
      src: "https://avatars.githubusercontent.com/u/499550?v=4",
      alt: "Evan You",
      loading: "lazy" as const,
    },
  },
  quote: "“Nuxt on Cloudflare infra with minimal effort - this is huge!”",
});
</script>

<template>
  <UPageCard :description="testimonial.quote" class="w-60">
    <template #footer>
      <UUser v-bind="testimonial.user" />
    </template>
  </UPageCard>
</template>
```

> \[!TIP]
> See: /docs/components/page-columns
>
> You can use the `PageColumns` component to display multiple PageCard in a multi-column layout.
