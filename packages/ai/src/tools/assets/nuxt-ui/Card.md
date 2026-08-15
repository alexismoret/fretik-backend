# UCard

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Card component
 */
interface CardProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * @default 'outline'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | undefined;
  ui?:
    | {
        root?: SlotClass;
        header?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        body?: SlotClass;
        footer?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Card component
 */
interface CardSlots {
  header(): any;
  title(): any;
  description(): any;
  default(): any;
  footer(): any;
}
```

## Usage

Use the `header`, `default` and `footer` slots to add content to the Card.

```vue
<template>
  <UCard>
    <Placeholder class="h-32" />

    <template #header>
      <Placeholder class="h-8" />
    </template>
    <template #footer>
      <Placeholder class="h-8" /> </template
  ></UCard>
</template>
```

### Title `4.7+`

Use the `title` prop to set the title of the Card's header.

```vue
<template>
  <UCard title="Card with title" class="w-full">
    <Placeholder class="h-32" />
  </UCard>
</template>
```

### Description `4.7+`

Use the `description` prop to set the description of the Card's header.

```vue
<template>
  <UCard
    title="Card with description"
    description="Lorem ipsum dolor sit amet, consectetur adipiscing elit."
    class="w-full"
  >
    <Placeholder class="h-32" />
  </UCard>
</template>
```

### Variant

Use the `variant` prop to change the variant of the Card.

```vue
<template>
  <UCard variant="subtle">
    <Placeholder class="h-32" />

    <template #header>
      <Placeholder class="h-8" />
    </template>
    <template #footer>
      <Placeholder class="h-8" /> </template
  ></UCard>
</template>
```
