# UPageFeature

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageFeature component
 */
interface PageFeatureProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The icon displayed next to the title when `orientation` is `horizontal` and above the title when `orientation` is `vertical`.
   */
  icon?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The orientation of the page feature.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  to?: string | it | et | undefined;
  target?: null | "_blank" | "_parent" | "_self" | "_top" | string & {} | undefined;
  onClick?: (event: MouseEvent): void | undefined;
  ui?: { root?: SlotClass; wrapper?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; title?: SlotClass; description?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageFeature component
 */
interface PageFeatureSlots {
  leading(): any;
  title(): any;
  description(): any;
  default(): any;
}
```

## Usage

The PageFeature component is used by the [PageSection](https://ui.nuxt.com/docs/components/page-section) component to display [features](https://ui.nuxt.com/docs/components/page-section#features).

### Title

Use the `title` prop to set the title of the feature.

```vue
<template>
  <UPageFeature title="Theme" />
</template>
```

### Description

Use the `description` prop to set the description of the feature.

```vue
<template>
  <UPageFeature
    title="Theme"
    description="Customize Nuxt UI with your own colors, fonts, and more."
  />
</template>
```

### Icon

Use the `icon` prop to set the icon of the feature.

```vue
<template>
  <UPageFeature
    title="Theme"
    description="Customize Nuxt UI with your own colors, fonts, and more."
    icon="i-lucide-swatch-book"
  />
</template>
```

### Link

You can pass any property from the [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link){rel="&#x22;nofollow&#x22;"} component such as `to`, `target`, `rel`, etc.

```vue
<template>
  <UPageFeature
    title="Theme"
    description="Customize Nuxt UI with your own colors, fonts, and more."
    icon="i-lucide-swatch-book"
    to="/docs/getting-started/theme/design-system"
    target="_blank"
  />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the feature. Defaults to `horizontal`.

```vue
<template>
  <UPageFeature
    orientation="vertical"
    title="Theme"
    description="Customize Nuxt UI with your own colors, fonts, and more."
    icon="i-lucide-swatch-book"
  />
</template>
```
