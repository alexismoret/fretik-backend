# UPageAside

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageAside component
 */
interface PageAsideProps {
  /**
   * The element or component this component should render as.
   * @default 'aside'
   */
  as?: any;
  ui?: { root?: SlotClass; container?: SlotClass; top?: SlotClass; topHeader?: SlotClass; topBody?: SlotClass; topFooter?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageAside component
 */
interface PageAsideSlots {
  top(): any;
  default(): any;
  bottom(): any;
}
```

## Composition

Parts placed by name: `#top`, `#bottom`.

Also written in the docs and absent from the interface above — one per column or item: `#left`.

## Usage

The PageAside component is a sticky `<aside>` element that is only displayed starting from the [`lg` breakpoint](https://tailwindcss.com/docs/breakpoints).

> [!TIP]
> See: /docs/getting-started/theme/css-variables#header
> 
> The PageAside component uses the `--ui-header-height` CSS variable to position itself correctly below the `Header`.

Use it inside the `left` or `right` slot of the [Page](https://ui.nuxt.com/docs/components/page) component:

```vue
<template>
  <UPage>
    <template #left>
      <UPageAside />
    </template>
  </UPage>
</template>
```

## Examples

> [!NOTE]
> 
> While these examples use [Nuxt Content](https://content.nuxt.com), the components can be integrated with any content management system.

### Within a layout

Use the PageAside component in a layout to display the navigation:

```vue [layouts/docs.vue]
<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'

const navigation = inject<Ref<ContentNavigationItem[]>>('navigation')
</script>

<template>
  <UPage>
    <template #left>
      <UPageAside>
        <UContentNavigation :navigation="navigation" />
      </UPageAside>
    </template>

    <slot />
  </UPage>
</template>
```

> [!NOTE]
> 
> In this example, we use the `ContentNavigation` component to display the navigation injected in `app.vue`.
