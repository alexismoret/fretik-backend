# UPageAnchors

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageAnchors component
 */
interface PageAnchorsProps {
  /**
   * The element or component this component should render as.
   * @default 'nav'
   */
  as?: any;
  links?: T[] | undefined;
  ui?:
    | {
        root?: SlotClass;
        list?: SlotClass;
        item?: SlotClass;
        link?: SlotClass;
        linkLeading?: SlotClass;
        linkLeadingIcon?: SlotClass;
        linkLabel?: SlotClass;
        linkLabelExternalIcon?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageAnchors component
 */
interface PageAnchorsSlots {
  link(): any;
  link-leading(): any;
  link-label(): any;
  link-trailing(): any;
}
```

## Usage

Use the PageAnchors component to display a list of links.

```vue
<script setup lang="ts">
import type { PageAnchor } from "@nuxt/ui";

const links = ref<PageAnchor[]>([
  {
    label: "Documentation",
    icon: "i-lucide-book-open",
    to: "/docs/getting-started",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components",
  },
  {
    label: "Figma Kit",
    icon: "i-simple-icons-figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    icon: "i-simple-icons-github",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);
</script>

<template>
  <UPageAnchors :links="links" />
</template>
```

### Links

Use the `links` prop as an array of objects with the following properties:

- `label: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, link?: ClassNameValue, linkLabel?: ClassNameValue, linkLabelExternalIcon?: ClassNameValue, linkLeading?: ClassNameValue, linkLeadingIcon?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { PageAnchor } from "@nuxt/ui";

const links = ref<PageAnchor[]>([
  {
    label: "Documentation",
    icon: "i-lucide-book-open",
    to: "/docs/getting-started",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components",
  },
  {
    label: "Figma Kit",
    icon: "i-simple-icons-figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    icon: "i-simple-icons-github",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);
</script>

<template>
  <UPageAnchors :links="links" />
</template>
```

## Examples

> \[!NOTE]
>
> While these examples use [Nuxt Content](https://content.nuxt.com){rel="&#x22;nofollow&#x22;"}, the components can be integrated with any content management system.

### Within a layout

Use the PageAnchors component inside the [PageAside](https://ui.nuxt.com/docs/components/page-aside) component to display a list of links above the navigation.

```vue [layouts/docs.vue] {35}
<script setup lang="ts">
import type { PageAnchor } from "@nuxt/ui";
import type { ContentNavigationItem } from "@nuxt/content";

const navigation = inject<ContentNavigationItem[]>("navigation");

const links: PageAnchor[] = [
  {
    label: "Documentation",
    icon: "i-lucide-book-open",
    to: "/docs/getting-started",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components",
  },
  {
    label: "Figma Kit",
    icon: "i-simple-icons-figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
];
</script>

<template>
  <UPage>
    <template #left>
      <UPageAside>
        <UPageAnchors :links="links" />

        <USeparator type="dashed" />

        <UContentNavigation :navigation="navigation" />
      </UPageAside>
    </template>

    <slot />
  </UPage>
</template>
```
