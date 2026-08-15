# UPageCTA

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageCTA component
 */
interface PageCTAProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The orientation of the page cta.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * Reverse the order of the default slot.
   * @default false
   */
  reverse?: boolean | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "solid" | "soft" | "subtle" | "naked" | undefined;
  /**
   * Display a list of Button under the description.
   * `{ size: 'lg' }`{lang="ts-type"}
   */
  links?: ButtonProps[] | undefined;
  ui?:
    | {
        root?: SlotClass;
        container?: SlotClass;
        wrapper?: SlotClass;
        header?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        body?: SlotClass;
        footer?: SlotClass;
        links?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageCTA component
 */
interface PageCTASlots {
  top(): any;
  header(): any;
  title(): any;
  description(): any;
  body(): any;
  footer(): any;
  links(): any;
  default(): any;
  bottom(): any;
}
```

## Usage

The PageCTA component provides a flexible way to display a call to action in your pages with an illustration in the default slot.

```vue
<template>
  <u-page-c-t-a :links=[{"label":"Get started","color":"neutral"},{"label":"Learn more","color":"neutral","variant":"subtle","trailingIcon":"i-lucide-arrow-right"}] description=Preview the latest Tailwind CSS and get started with Nuxt UI. orientation=horizontal title=Trusted and supported by our amazing community>
  <img alt=Illustration src=https://picsum.photos/640/616 /></u-page-c-t-a>
</template>
```

Use it inside a [PageSection](https://ui.nuxt.com/docs/components/page-section) component or directly in your page:

```vue {4,8-10}
<template>
  <UPageHero />

  <UPageCTA class="rounded-none" />

  <UPageSection />

  <UPageSection :ui="{ container: 'px-0' }">
    <UPageCTA class="rounded-none sm:rounded-xl" />
  </UPageSection>

  <UPageSection />
</template>
```

> \[!TIP]
>
> Use `px-0` and `rounded-none` classes to make the CTA fill the edge of the page on mobile.

### Title

Use the `title` prop to set the title of the CTA.

```vue
<template>
  <UPageCTA title="Trusted and supported by our amazing community" />
</template>
```

### Description

Use the `description` prop to set the description of the CTA.

```vue
<template>
  <UPageCTA
    title="Trusted and supported by our amazing community"
    description="We've built a strong, lasting partnership. Their trust is our driving force, propelling us towards shared success."
  />
</template>
```

### Links

Use the `links` prop to display a list of [Button](https://ui.nuxt.com/docs/components/button) under the description.

```vue
<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    color: "neutral",
  },
  {
    label: "Learn more",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right",
  },
]);
</script>

<template>
  <UPageCTA
    title="Trusted and supported by our amazing community"
    description="We've built a strong, lasting partnership. Their trust is our driving force, propelling us towards shared success."
    :links="links"
  />
</template>
```

### Variant

Use the `variant` prop to change the style of the CTA.

```vue
<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    color: "neutral",
  },
  {
    label: "Learn more",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right",
  },
]);
</script>

<template>
  <UPageCTA
    title="Trusted and supported by our amazing community"
    description="We've built a strong, lasting partnership. Their trust is our driving force, propelling us towards shared success."
    variant="soft"
    :links="links"
  />
</template>
```

> \[!TIP]
>
> You can apply the `light` or `dark` class to the `links` slot when using the `solid` variant to reverse the colors.

### Orientation

Use the `orientation` prop to change the orientation with the default slot. Defaults to `vertical`.

```vue
<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    color: "neutral",
  },
  {
    label: "Learn more",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right",
  },
]);
</script>

<template>
  <UPageCTA
    title="Trusted and supported by our amazing community"
    description="We've built a strong, lasting partnership. Their trust is our driving force, propelling us towards shared success."
    orientation="horizontal"
    :links="links"
  >
    <img
      src="https://picsum.photos/640/728"
      width="320"
      height="364"
      alt="Illustration"
      class="w-full rounded-lg"
      loading="lazy"
    />
  </UPageCTA>
</template>
```

### Reverse

Use the `reverse` prop to reverse the orientation of the default slot.

```vue
<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";

const links = ref<ButtonProps[]>([
  {
    label: "Get started",
    color: "neutral",
  },
  {
    label: "Learn more",
    color: "neutral",
    variant: "subtle",
    trailingIcon: "i-lucide-arrow-right",
  },
]);
</script>

<template>
  <UPageCTA
    title="Trusted and supported by our amazing community"
    description="We've built a strong, lasting partnership. Their trust is our driving force, propelling us towards shared success."
    orientation="horizontal"
    reverse
    :links="links"
  >
    <img
      src="https://picsum.photos/640/728"
      width="320"
      height="364"
      alt="Illustration"
      class="w-full rounded-lg"
      loading="lazy"
    />
  </UPageCTA>
</template>
```
