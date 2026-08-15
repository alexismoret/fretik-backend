# UChip

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Chip component
 */
interface ChipProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Display some text inside the chip.
   */
  text?: string | number | undefined;
  /**
   * @default 'primary'
   */
  color?:
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | "error"
    | "neutral"
    | undefined;
  /**
   * @default 'md'
   */
  size?:
    | "xs"
    | "sm"
    | "md"
    | "lg"
    | "xl"
    | "3xs"
    | "2xs"
    | "2xl"
    | "3xl"
    | undefined;
  /**
   * The position of the chip.
   * @default 'top-right'
   */
  position?:
    "top-right" | "bottom-right" | "top-left" | "bottom-left" | undefined;
  /**
   * When `true`, keep the chip inside the component for rounded elements.
   * @default false
   */
  inset?: boolean | undefined;
  /**
   * When `true`, render the chip relatively to the parent.
   * @default false
   */
  standalone?: boolean | undefined;
  ui?: { root?: SlotClass; base?: SlotClass } | undefined;
  /**
   * @default true
   */
  show?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Chip component
 */
interface ChipSlots {
  default(): any;
  content(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Chip component
 */
interface ChipEmits {
  update:show: (payload: [value: boolean]) => void;
}
```

## Usage

Wrap any component with a Chip to display an indicator.

```vue
<template>
  <UChip>
    <UButton icon="i-lucide-mail" color="neutral" variant="subtle" />
  </UChip>
</template>
```

### Color

Use the `color` prop to change the color of the Chip.

```vue
<template>
  <UChip color="neutral">
    <UButton icon="i-lucide-mail" color="neutral" variant="subtle" />
  </UChip>
</template>
```

### Size

Use the `size` prop to change the size of the Chip.

```vue
<template>
  <UChip size="3xl">
    <UButton icon="i-lucide-mail" color="neutral" variant="subtle" />
  </UChip>
</template>
```

### Text

Use the `text` prop to set the text of the Chip.

```vue
<template>
  <UChip :text="5" size="3xl">
    <UButton icon="i-lucide-mail" color="neutral" variant="subtle" />
  </UChip>
</template>
```

### Position

Use the `position` prop to change the position of the Chip.

```vue
<template>
  <UChip position="bottom-left">
    <UButton icon="i-lucide-mail" color="neutral" variant="subtle" />
  </UChip>
</template>
```

### Inset

Use the `inset` prop to display the Chip inside the component. This is useful when dealing with rounded components.

```vue
<template>
  <UChip inset>
    <UAvatar src="https://github.com/benjamincanac.png" loading="lazy" />
  </UChip>
</template>
```

### Standalone

Use the `standalone` prop alongside the `inset` prop to display the Chip inline.

```vue
<template>
  <UChip standalone inset />
</template>
```

> \[!NOTE]
>
> It's used this way in the [`CommandPalette`](https://ui.nuxt.com/docs/components/command-palette), [`InputMenu`](https://ui.nuxt.com/docs/components/input-menu), [`Select`](https://ui.nuxt.com/docs/components/select) or [`SelectMenu`](https://ui.nuxt.com/docs/components/select-menu) components for example.

## Examples

### Control visibility

You can control the visibility of the Chip using the `show` prop.

```vue [ChipShowExample.vue]
<script setup lang="ts">
const statuses = ["online", "away", "busy", "offline"];
const status = ref(statuses[0]);

const color = computed(() =>
  status.value
    ? ({
        online: "success",
        away: "warning",
        busy: "error",
        offline: "neutral",
      }[status.value] as any)
    : "online",
);

const show = computed(() => status.value !== "offline");

// Note: This is for demonstration purposes only. Don't do this at home.
onMounted(() => {
  setInterval(() => {
    if (status.value) {
      status.value =
        statuses[(statuses.indexOf(status.value) + 1) % statuses.length];
    }
  }, 1000);
});
</script>

<template>
  <UChip :color="color" :show="show" inset>
    <UAvatar src="https://github.com/benjamincanac.png" loading="lazy" />
  </UChip>
</template>
```

> \[!NOTE]
>
> In this example, the Chip has a color per status and is displayed when the status is not `offline`.
