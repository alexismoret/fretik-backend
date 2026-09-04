# UContainer

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Container component
 */
interface ContainerProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?: { base?: any; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Container component
 */
interface ContainerSlots {
  default(): any;
}
```

## Usage

Use the default slot to center and constrain the width of your content.

> [!TIP]
> See: /docs/getting-started/theme/css-variables#container
> 
> Its max width is controlled by the `--ui-container` CSS variable.

```vue [ContainerExample.vue]
<template>
  <UContainer>
    <Placeholder class="h-32" />
  </UContainer>
</template>
```
