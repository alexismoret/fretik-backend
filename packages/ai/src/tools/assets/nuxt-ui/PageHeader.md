# UPageHeader

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PageHeader component
 */
interface PageHeaderProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  headline?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Display a list of Button next to the title.
   * `{ color: 'neutral', variant: 'outline' }`{lang="ts-type"}
   */
  links?: ButtonProps[] | undefined;
  ui?:
    | {
        root?: SlotClass;
        container?: SlotClass;
        wrapper?: SlotClass;
        headline?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        links?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PageHeader component
 */
interface PageHeaderSlots {
  headline(): any;
  title(): any;
  description(): any;
  links(): any;
  default(): any;
}
```

## Usage

The PageHeader component displays a header for your page.

Use it inside the default slot of the [Page](https://ui.nuxt.com/docs/components/page) component, before the [PageBody](https://ui.nuxt.com/docs/components/page-body) component:

```vue {3}
<template>
  <UPage>
    <UPageHeader />

    <UPageBody />
  </UPage>
</template>
```

### Title

Use the `title` prop to display a title in the header.

```vue
<template>
  <UPageHeader title="PageHeader" />
</template>
```

### Description

Use the `description` prop to display a description in the header.

```vue
<template>
  <UPageHeader
    title="PageHeader"
    description="A responsive page header with title, description and actions."
  />
</template>
```

### Headline

Use the `headline` prop to display a headline in the header.

```vue
<template>
  <UPageHeader
    title="PageHeader"
    description="A responsive page header with title, description and actions."
    headline="Components"
  />
</template>
```

### Links

Use the `links` prop to display a list of [Button](https://ui.nuxt.com/docs/components/button) in the header.

```vue
<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";

const links = ref<ButtonProps[]>([
  {
    label: "GitHub",
    icon: "i-simple-icons-github",
    to: "https://github.com/nuxt/ui/tree/v4/src/runtime/components/PageHeader.vue",
    target: "_blank",
  },
]);
</script>

<template>
  <UPageHeader
    title="PageHeader"
    description="A responsive page header with title, description and actions."
    headline="Components"
    :links="links"
  />
</template>
```

## Examples

> \[!NOTE]
>
> While these examples use [Nuxt Content](https://content.nuxt.com){rel="&#x22;nofollow&#x22;"}, the components can be integrated with any content management system.

### Within a page

Use the PageHeader component in a page to display the header of the page:

```vue [pages/[...slug\].vue] {19-24}
<script setup lang="ts">
const route = useRoute();

definePageMeta({
  layout: "docs",
});

const { data: page } = await useAsyncData(route.path, () => {
  return queryCollection("docs").path(route.path).first();
});

const { data: surround } = await useAsyncData(`${route.path}-surround`, () => {
  return queryCollectionItemSurroundings("content", route.path);
});
</script>

<template>
  <UPage>
    <UPageHeader
      :title="page.title"
      :description="page.description"
      :headline="page.headline"
      :links="page.links"
    />

    <UPageBody>
      <ContentRenderer :value="page" />

      <USeparator />

      <UContentSurround :surround="surround" />
    </UPageBody>

    <template #right>
      <UContentToc :links="page.body.toc.links" />
    </template>
  </UPage>
</template>
```
