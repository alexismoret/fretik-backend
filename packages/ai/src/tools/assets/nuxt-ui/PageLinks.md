# UPageLinks

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageLinks component
 */
interface PageLinksProps {
  /**
   * The element or component this component should render as.
   * @default 'nav'
   */
  as?: any;
  title?: string | undefined;
  links?: T[] | undefined;
  ui?: { root?: SlotClass; title?: SlotClass; list?: SlotClass; item?: SlotClass; link?: SlotClass; linkLeadingIcon?: SlotClass; linkLabel?: SlotClass; linkLabelExternalIcon?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageLinks component
 */
interface PageLinksSlots {
  title(): any;
  link(): any;
  link-leading(): any;
  link-label(): any;
  link-trailing(): any;
}
```

## Composition

Parts placed by name: `#link`, `#link-leading`, `#link-label`, `#link-trailing`.

Also written in the docs and absent from the interface above — one per column or item: `#right`, `#bottom`.

## Usage

Use the PageLinks component to display a list of links.

```vue
<script setup lang="ts">
import type { PageLink } from '@nuxt/ui'

const links = ref<PageLink[]>([
  {
    label: "Edit this page",
    icon: "i-lucide-file-pen",
    to: "https://github.com/nuxt/ui/blob/v4/docs/content/docs/2.components/page-links.md"
  },
  {
    label: "Star on GitHub",
    icon: "i-lucide-star",
    to: "https://github.com/nuxt/ui"
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases"
  }
])
</script>

<template>
  <UPageLinks :links="links" />
</template>
```

### Links

Use the `links` prop as an array of objects with the following properties:

- `label: string`
- `icon?: string`
- `class?: any`
- `ui?: { item?: ClassNameValue, link?: ClassNameValue, linkLabel?: ClassNameValue, linkLabelExternalIcon?: ClassNameValue, linkLeadingIcon?: ClassNameValue }`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { PageLink } from '@nuxt/ui'

const links = ref<PageLink[]>([
  {
    label: "Edit this page",
    icon: "i-lucide-file-pen",
    to: "https://github.com/nuxt/ui/blob/v4/docs/content/docs/2.components/page-links.md"
  },
  {
    label: "Star on GitHub",
    icon: "i-lucide-star",
    to: "https://github.com/nuxt/ui"
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases"
  }
])
</script>

<template>
  <UPageLinks :links="links" />
</template>
```

### Title

Use the `title` prop to display a title above the links.

```vue
<script setup lang="ts">
import type { PageLink } from '@nuxt/ui'

const links = ref<PageLink[]>([
  {
    label: "Edit this page",
    icon: "i-lucide-file-pen",
    to: "https://github.com/nuxt/ui/blob/v4/docs/content/docs/2.components/page-links.md"
  },
  {
    label: "Star on GitHub",
    icon: "i-lucide-star",
    to: "https://github.com/nuxt/ui"
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases"
  }
])
</script>

<template>
  <UPageLinks title="Community" :links="links" />
</template>
```

## Examples

> [!NOTE]
> 
> While these examples use [Nuxt Content](https://content.nuxt.com), the components can be integrated with any content management system.

### Within a page

Use the PageLinks component in the `bottom` slot of the ContentToc component to display a list of links below the table of contents.

```vue [pages/[...slug].vue]
<script setup lang="ts">
import type { PageLink } from '@nuxt/ui'

const route = useRoute()

definePageMeta({
  layout: 'docs'
})

const { data: page } = await useAsyncData(route.path, () => {
  return queryCollection('docs').path(route.path).first()
})

const { data: surround } = await useAsyncData(`${route.path}-surround`, () => {
  return queryCollectionItemSurroundings('content', route.path)
})

const links = computed<PageLink[]>(() => [{
  icon: 'i-lucide-file-pen',
  label: 'Edit this page',
  to: `https://github.com/nuxt/ui/edit/v4/docs/content/${page?.value?.stem}.md`,
  target: '_blank'
}, {
  icon: 'i-lucide-star',
  label: 'Star on GitHub',
  to: 'https://github.com/nuxt/ui',
  target: '_blank'
}, {
  label: 'Releases',
  icon: 'i-lucide-rocket',
  to: 'https://github.com/nuxt/ui/releases'
}])
</script>

<template>
  <UPage>
    <UPageHeader :title="page.title" :description="page.description" />

    <UPageBody>
      <ContentRenderer :value="page" />

      <USeparator />

      <UContentSurround :surround="surround" />
    </UPageBody>

    <template #right>
      <UContentToc :links="page.body.toc.links">
        <template #bottom>
          <USeparator type="dashed" />

          <UPageLinks title="Community" :links="links" />
        </template>
      </UContentToc>
    </template>
  </UPage>
</template>
```
