# UPageHero

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageHero component
 */
interface PageHeroProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  headline?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Display a list of Button under the description.
   * `{ size: 'xl' }`{lang="ts-type"}
   */
  links?: ButtonProps[] | undefined;
  /**
   * The orientation of the page hero.
   * @default 'vertical'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * Reverse the order of the default slot.
   * @default false
   */
  reverse?: boolean | undefined;
  ui?: { root?: SlotClass; container?: SlotClass; wrapper?: SlotClass; header?: SlotClass; headline?: SlotClass; title?: SlotClass; description?: SlotClass; body?: SlotClass; footer?: SlotClass; links?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageHero component
 */
interface PageHeroSlots {
  top(): any;
  header(): any;
  headline(): any;
  title(): any;
  description(): any;
  body(): any;
  footer(): any;
  links(): any;
  default(): any;
  bottom(): any;
}
```

## Composition

Parts placed by name: `#top`, `#headline`, `#body`, `#links`, `#bottom`.

## Usage

The PageHero component wraps your content in a [Container](https://ui.nuxt.com/docs/components/container) while maintaining full-width flexibility making it easy to add background colors, images or patterns. It provides a flexible way to display content with an illustration in the default slot.

```vue
<template>
  <u-page-hero description="A Nuxt/Vue-integrated UI library providing a rich set of fully-styled, accessible and highly customizable components for building modern web applications." title="Ultimate Vue UI library">
    <u-page-card class="rounded-lg" variant="subtle">
      <p>
        <img alt="App screenshot" class="rounded-sm shadow-2xl ring ring-default" src="/blocks/image4.png" :height="540" :width="960" />
      </p>
    </u-page-card>
  </u-page-hero>
</template>
```

### Title

Use the `title` prop to set the title of the hero.

```vue
<template>
  <UPageHero title="Ultimate Vue UI library" />
</template>
```

### Description

Use the `description` prop to set the description of the hero.

```vue
<template>
  <UPageHero title="Ultimate Vue UI library" description="A Nuxt/Vue-integrated UI library providing a rich set of fully-styled, accessible and highly customizable components for building modern web applications." />
</template>
```

### Headline

Use the `headline` prop to set the headline of the hero.

```vue
<template>
  <UPageHero title="Ultimate Vue UI library" description="A Nuxt/Vue-integrated UI library providing a rich set of fully-styled, accessible and highly customizable components for building modern web applications." headline="New release" />
</template>
```

### Links

Use the `links` prop to display a list of [Button](https://ui.nuxt.com/docs/components/button) under the description.

```vue
<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    to: "/docs/getting-started",
    icon: "i-lucide-square-play"
  },
  {
    label: "Learn more",
    to: "/docs/getting-started/theme/design-system",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right"
  }
])
</script>

<template>
  <UPageHero title="Ultimate Vue UI library" description="A Nuxt/Vue-integrated UI library providing a rich set of fully-styled, accessible and highly customizable components for building modern web applications." :links="links" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation with the default slot. Defaults to `vertical`.

```vue
<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    to: "/docs/getting-started",
    icon: "i-lucide-square-play"
  },
  {
    label: "Learn more",
    to: "/docs/getting-started/theme/design-system",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right"
  }
])
</script>

<template>
  <UPageHero title="Ultimate Vue UI library" description="A Nuxt/Vue-integrated UI library providing a rich set of fully-styled, accessible and highly customizable components for building modern web applications." headline="New release" orientation="horizontal" :links="links">
    <img src="/blocks/image4.png" alt="App screenshot" class="rounded-lg shadow-2xl ring ring-default" />
  </UPageHero>
</template>
```

### Reverse

Use the `reverse` prop to reverse the orientation of the default slot.

```vue
<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    to: "/docs/getting-started",
    icon: "i-lucide-square-play"
  },
  {
    label: "Learn more",
    to: "/docs/getting-started/theme/design-system",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right"
  }
])
</script>

<template>
  <UPageHero title="Ultimate Vue UI library" description="A Nuxt/Vue-integrated UI library providing a rich set of fully-styled, accessible and highly customizable components for building modern web applications." headline="New release" orientation="horizontal" reverse :links="links">
    <img src="/blocks/image4.png" alt="App screenshot" class="rounded-lg shadow-2xl ring ring-default" />
  </UPageHero>
</template>
```
