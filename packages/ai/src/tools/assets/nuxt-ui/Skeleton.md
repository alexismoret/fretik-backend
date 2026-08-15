# USkeleton

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Skeleton component
 */
interface SkeletonProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?: { base?: any } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Skeleton component
 */
interface SkeletonSlots {
  default(): any;
}
```

## Usage

Use the Skeleton component as-is to display a placeholder.

```vue [SkeletonExample.vue]
<template>
  <div class="flex items-center gap-4">
    <USkeleton class="size-12 rounded-full" />

    <div class="grid gap-2">
      <USkeleton class="h-4 w-[250px]" />
      <USkeleton class="h-4 w-[200px]" />
    </div>
  </div>
</template>
```
