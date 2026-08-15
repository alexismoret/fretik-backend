# UMain

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Main component
 */
interface MainProps {
  /**
   * The element or component this component should render as.
   * @default 'main'
   */
  as?: any;
  ui?: { base?: any } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Main component
 */
interface MainSlots {
  default(): any;
}
```

## Usage

The Main component renders a `<main>` element that works together with the [Header](https://ui.nuxt.com/docs/components/header) component to create a full-height layout that extends to the viewport's available height.

> \[!TIP]
> See: /docs/getting-started/theme/css-variables#header
>
> The Main component uses the `--ui-header-height` CSS variable to position itself correctly below the `Header`.

## Examples

### Within `app.vue`

Use the Main component in your `app.vue` or in a layout:

```vue [app.vue] {5-9}
<template>
  <UApp>
    <UHeader />

    <UMain>
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </UMain>

    <UFooter />
  </UApp>
</template>
```
