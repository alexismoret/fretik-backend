# UPagination

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Pagination component
 */
interface PaginationProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The icon to use for the first page control.
   * @default appConfig.ui.icons.chevronDoubleLeft
   */
  firstIcon?: any;
  /**
   * The icon to use for the previous page control.
   * @default appConfig.ui.icons.chevronLeft
   */
  prevIcon?: any;
  /**
   * The icon to use for the next page control.
   * @default appConfig.ui.icons.chevronRight
   */
  nextIcon?: any;
  /**
   * The icon to use for the last page control.
   * @default appConfig.ui.icons.chevronDoubleRight
   */
  lastIcon?: any;
  /**
   * The icon to use for the ellipsis control.
   * @default appConfig.ui.icons.ellipsis
   */
  ellipsisIcon?: any;
  /**
   * The color of the pagination controls.
   * @default 'neutral'
   */
  color?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  /**
   * The variant of the pagination controls.
   * @default 'outline'
   */
  variant?: "outline" | "solid" | "soft" | "subtle" | "ghost" | "link" | undefined;
  /**
   * The color of the active pagination control.
   * @default 'primary'
   */
  activeColor?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  /**
   * The variant of the active pagination control.
   * @default 'solid'
   */
  activeVariant?: "outline" | "solid" | "soft" | "subtle" | "ghost" | "link" | undefined;
  /**
   * Whether to show the first, previous, next, and last controls.
   * @default true
   */
  showControls?: boolean | undefined;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * A function to render page controls as links.
   */
  to?: (page: number): string | RouteLocationAsRelativeGeneric | RouteLocationAsPathGeneric | undefined | undefined;
  ui?: { root?: SlotClass; list?: SlotClass; ellipsis?: SlotClass; label?: SlotClass; first?: SlotClass; prev?: SlotClass; item?: SlotClass; next?: SlotClass; last?: SlotClass; } | undefined;
  /**
   * The value of the page that should be active when initially rendered.
   *
   * Use when you do not need to control the value state.
   */
  defaultPage?: number | undefined;
  /**
   * When `true`, prevents the user from interacting with item
   */
  disabled?: boolean | undefined;
  /**
   * Number of items per page
   * @default 10
   */
  itemsPerPage?: number | undefined;
  /**
   * The controlled value of the current page. Can be binded as `v-model:page`.
   */
  page?: number | undefined;
  /**
   * When `true`, always show first page, last page, and ellipsis
   * @default false
   */
  showEdges?: boolean | undefined;
  /**
   * Number of sibling should be shown around the current page
   * @default 2
   */
  siblingCount?: number | undefined;
  /**
   * Number of items in your list
   * @default 0
   */
  total?: number | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Pagination component
 */
interface PaginationSlots {
  first(): any;
  prev(): any;
  next(): any;
  last(): any;
  ellipsis(): any;
  item(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Pagination component
 */
interface PaginationEmits {
  update:page: (payload: [value: number]) => void;
}
```

## Usage

Use the `default-page` prop or the `v-model:page` directive to control the current page.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" :total="100" />
</template>
```

> \[!NOTE]
>
> The Pagination component uses some [`Button`](https://ui.nuxt.com/docs/components/button) to display the pages, use [`color`](https://ui.nuxt.com/#color), [`variant`](https://ui.nuxt.com/#variant) and [`size`](https://ui.nuxt.com/#size) props to style them.

### Total

Use the `total` prop to set the total number of items in the list.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" :total="100" />
</template>
```

### Items Per Page

Use the `items-per-page` prop to set the number of items per page. Defaults to `10`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" :items-per-page="20" :total="100" />
</template>
```

### Sibling Count

Use the `sibling-count` prop to set the number of siblings to show. Defaults to `2`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" :sibling-count="1" :total="100" />
</template>
```

### Show Edges

Use the `show-edges` prop to always show the ellipsis, first and last pages. Defaults to `false`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" show-edges :sibling-count="1" :total="100" />
</template>
```

### Show Controls

Use the `show-controls` prop to show the first, prev, next and last buttons. Defaults to `true`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination
    v-model:page="page"
    :show-controls="false"
    show-edges
    :total="100"
  />
</template>
```

### Color

Use the `color` prop to set the color of the inactive controls. Defaults to `neutral`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" color="primary" :total="100" />
</template>
```

### Variant

Use the `variant` prop to set the variant of the inactive controls. Defaults to `outline`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination
    v-model:page="page"
    color="neutral"
    variant="subtle"
    :total="100"
  />
</template>
```

### Active Color

Use the `active-color` prop to set the color of the active control. Defaults to `primary`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" active-color="neutral" :total="100" />
</template>
```

### Active Variant

Use the `active-variant` prop to set the variant of the active control. Defaults to `solid`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination
    v-model:page="page"
    active-color="primary"
    active-variant="subtle"
    :total="100"
  />
</template>
```

### Size

Use the `size` prop to set the size of the controls. Defaults to `md`.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" size="xl" :total="100" />
</template>
```

### Disabled

Use the `disabled` prop to disable the pagination controls.

```vue
<script setup lang="ts">
const page = ref(5);
</script>

<template>
  <UPagination v-model:page="page" :total="100" disabled />
</template>
```

## Examples

### With links

Use the `to` prop to transform buttons into links. Pass a function that receives the page number and returns a route destination.

```vue [PaginationLinksExample.vue]
<script setup lang="ts">
const page = ref(5);

function to(page: number) {
  return {
    query: {
      page,
    },
    hash: "#with-links",
  };
}
</script>

<template>
  <UPagination
    v-model:page="page"
    :total="100"
    :to="to"
    :sibling-count="1"
    show-edges
  />
</template>
```

> \[!NOTE]
>
> In this example we're adding the `#with-links` hash to avoid going to the top of the page.
