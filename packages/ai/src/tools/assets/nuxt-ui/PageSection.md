# UPageSection

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageSection component
 */
interface PageSectionProps {
  /**
   * The element or component this component should render as.
   * @default 'section'
   */
  as?: any;
  /**
   * The headline displayed above the title.
   */
  headline?: string | undefined;
  /**
   * The icon displayed above the title.
   */
  icon?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Display a list of Button under the description.
   * `{ size: 'lg' }`{lang="ts-type"}
   */
  links?: ButtonProps[] | undefined;
  /**
   * Display a list of PageFeature under the description.
   */
  features?: PageFeatureProps[] | undefined;
  /**
   * The orientation of the section.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * Reverse the order of the default slot.
   * @default false
   */
  reverse?: boolean | undefined;
  ui?: { root?: SlotClass; container?: SlotClass; wrapper?: SlotClass; header?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; headline?: SlotClass; title?: SlotClass; description?: SlotClass; body?: SlotClass; features?: SlotClass; footer?: SlotClass; links?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageSection component
 */
interface PageSectionSlots {
  top(): any;
  header(): any;
  leading(): any;
  headline(): any;
  title(): any;
  description(): any;
  body(): any;
  features(): any;
  footer(): any;
  links(): any;
  default(): any;
  bottom(): any;
}
```

## Composition

Parts placed by name: `#top`, `#headline`, `#body`, `#features`, `#links`, `#bottom`.

## Usage

The PageSection component wraps your content in a [Container](https://ui.nuxt.com/docs/components/container) while maintaining full-width flexibility making it easy to add background colors, images or patterns. It provides a flexible way to display content with an illustration in the default slot.

```vue
<template>
  <u-page-section :features="[
    {
      title: 'Icons',
      description: 'Nuxt UI integrates with Nuxt Icon to access over 200,000+ icons from Iconify.',
      icon: 'i-lucide-smile',
      to: '/docs/getting-started/integrations/icons'
    },
    {
      title: 'Fonts',
      description: 'Nuxt UI integrates with Nuxt Fonts to provide plug-and-play font optimization.',
      icon: 'i-lucide-a-large-small',
      to: '/docs/getting-started/integrations/fonts'
    },
    {
      title: 'Color Mode',
      description: 'Nuxt UI integrates with Nuxt Color Mode to switch between light and dark.',
      icon: 'i-lucide-sun-moon',
      to: '/docs/getting-started/integrations/color-mode'
    }
  ]" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." headline="Features" title="Beautiful Vue UI components" />
</template>
```

Use it after a [PageHero](https://ui.nuxt.com/docs/components/page-hero) component:

```vue
<template>
  <UPageHero />

  <UPageSection />
</template>
```

### Title

Use the `title` prop to set the title of the section.

```vue
<template>
  <UPageSection title="Beautiful Vue UI components" />
</template>
```

### Description

Use the `description` prop to set the description of the section.

```vue
<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." />
</template>
```

### Headline

Use the `headline` prop to set the headline of the section.

```vue
<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." headline="Features" />
</template>
```

### Icon

Use the `icon` prop to set the icon of the section.

```vue
<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." icon="i-lucide-rocket" />
</template>
```

### Features

Use the `features` prop to display a list of [PageFeature](https://ui.nuxt.com/docs/components/page-feature) under the description as an array of objects with the following properties:

- `title?: string`
- `description?: string`
- `icon?: string`
- `orientation?: 'horizontal' | 'vertical'`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { PageFeatureProps } from '@nuxt/ui'

const features = ref<PageFeatureProps[]>([
  {
    title: "Icons",
    description: "Nuxt UI integrates with Nuxt Icon to access over 200,000+ icons from Iconify.",
    icon: "i-lucide-smile",
    to: "/docs/getting-started/integrations/icons"
  },
  {
    title: "Fonts",
    description: "Nuxt UI integrates with Nuxt Fonts to provide plug-and-play font optimization.",
    icon: "i-lucide-a-large-small",
    to: "/docs/getting-started/integrations/fonts"
  },
  {
    title: "Color Mode",
    description: "Nuxt UI integrates with Nuxt Color Mode to switch between light and dark.",
    icon: "i-lucide-sun-moon",
    to: "/docs/getting-started/integrations/color-mode"
  }
])
</script>

<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." :features="features" />
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
    icon: "i-lucide-square-play",
    color: "neutral"
  },
  {
    label: "Explore components",
    to: "/docs/components/app",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right"
  }
])
</script>

<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." :links="links" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation with the default slot. Defaults to `vertical`.

```vue
<script setup lang="ts">
import type { PageFeatureProps, ButtonProps } from '@nuxt/ui'

const features = ref<PageFeatureProps[]>([
  {
    title: "Icons",
    description: "Nuxt UI integrates with Nuxt Icon to access over 200,000+ icons from Iconify.",
    icon: "i-lucide-smile",
    to: "/docs/getting-started/integrations/icons"
  },
  {
    title: "Fonts",
    description: "Nuxt UI integrates with Nuxt Fonts to provide plug-and-play font optimization.",
    icon: "i-lucide-a-large-small",
    to: "/docs/getting-started/integrations/fonts"
  },
  {
    title: "Color Mode",
    description: "Nuxt UI integrates with Nuxt Color Mode to switch between light and dark.",
    icon: "i-lucide-sun-moon",
    to: "/docs/getting-started/integrations/color-mode"
  }
])
const links = ref<ButtonProps[]>([
  {
    label: "Explore components",
    to: "/docs/components/app",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right"
  }
])
</script>

<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." icon="i-lucide-rocket" orientation="horizontal" :features="features" :links="links">
    <img src="https://picsum.photos/704/1294" width="352" height="647" alt="Illustration" class="w-full rounded-lg" loading="lazy" />
  </UPageSection>
</template>
```

### Reverse

Use the `reverse` prop to reverse the orientation of the default slot.

```vue
<script setup lang="ts">
import type { PageFeatureProps, ButtonProps } from '@nuxt/ui'

const features = ref<PageFeatureProps[]>([
  {
    title: "Icons",
    description: "Nuxt UI integrates with Nuxt Icon to access over 200,000+ icons from Iconify.",
    icon: "i-lucide-smile",
    to: "/docs/getting-started/integrations/icons"
  },
  {
    title: "Fonts",
    description: "Nuxt UI integrates with Nuxt Fonts to provide plug-and-play font optimization.",
    icon: "i-lucide-a-large-small",
    to: "/docs/getting-started/integrations/fonts"
  },
  {
    title: "Color Mode",
    description: "Nuxt UI integrates with Nuxt Color Mode to switch between light and dark.",
    icon: "i-lucide-sun-moon",
    to: "/docs/getting-started/integrations/color-mode"
  }
])
const links = ref<ButtonProps[]>([
  {
    label: "Explore components",
    to: "/docs/components/app",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right"
  }
])
</script>

<template>
  <UPageSection title="Beautiful Vue UI components" description="Nuxt UI provides a comprehensive suite of components and utilities to help you build beautiful and accessible web applications with Vue and Nuxt." icon="i-lucide-rocket" orientation="horizontal" reverse :features="features" :links="links">
    <img src="https://picsum.photos/704/1294" width="352" height="647" alt="Illustration" class="w-full rounded-lg" loading="lazy" />
  </UPageSection>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
