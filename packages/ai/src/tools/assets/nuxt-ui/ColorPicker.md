# UColorPicker

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ColorPicker component
 */
interface ColorPickerProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Throttle time in ms for the color picker
   * @default 50
   */
  throttle?: number | undefined;
  /**
   * Disable the color picker
   */
  disabled?: boolean | undefined;
  /**
   * The default value of the color picker
   * @default '#FFFFFF'
   */
  defaultValue?: string | undefined;
  /**
   * Format of the color
   * @default 'hex'
   */
  format?: "hex" | "rgb" | "hsl" | "cmyk" | "lab" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  ui?: { root?: SlotClass; picker?: SlotClass; selector?: SlotClass; selectorBackground?: SlotClass; selectorThumb?: SlotClass; track?: SlotClass; trackThumb?: SlotClass; } | undefined;
  modelValue?: string | undefined;
}
```

### Emits

```ts
/**
 * Emitted events for the ColorPicker component
 */
interface ColorPickerEmits {
  update:modelValue: (payload: [value: string | undefined]) => void;
}
```

## Composition

Also written in the docs and absent from the interface above — one per column or item: `#leading`, `#content`.

## Usage

Use the `v-model` directive to control the value of the ColorPicker.

```vue
<script setup lang="ts">
const value = ref("#00C16A")
</script>

<template>
  <UColorPicker v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<template>
  <UColorPicker default-value="#00BCD4" />
</template>
```

### RGB Format

Use the `format` prop to set `rgb` value of the ColorPicker.

```vue
<script setup lang="ts">
const value = ref("rgb(0, 193, 106)")
</script>

<template>
  <UColorPicker format="rgb" v-model="value" />
</template>
```

### HSL Format

Use the `format` prop to set `hsl` value of the ColorPicker.

```vue
<script setup lang="ts">
const value = ref("hsl(153, 100%, 37.8%)")
</script>

<template>
  <UColorPicker format="hsl" v-model="value" />
</template>
```

### CMYK Format

Use the `format` prop to set `cmyk` value of the ColorPicker.

```vue
<script setup lang="ts">
const value = ref("cmyk(100%, 0%, 45.08%, 24.31%)")
</script>

<template>
  <UColorPicker format="cmyk" v-model="value" />
</template>
```

### CIELab Format

Use the `format` prop to set `lab` value of the ColorPicker.

```vue
<script setup lang="ts">
const value = ref("lab(68.88% -60.41% 32.55%)")
</script>

<template>
  <UColorPicker format="lab" v-model="value" />
</template>
```

### Throttle

Use the `throttle` prop to set the throttle value of the ColorPicker.

```vue
<script setup lang="ts">
const value = ref("#00C16A")
</script>

<template>
  <UColorPicker :throttle="100" v-model="value" />
</template>
```

### Size

Use the `size` prop to set the size of the ColorPicker.

```vue
<template>
  <UColorPicker size="xl" />
</template>
```

### Disabled

Use the `disabled` prop to disable the ColorPicker.

```vue
<template>
  <UColorPicker disabled />
</template>
```

## Examples

### As a color chooser

Use a [Button](https://ui.nuxt.com/docs/components/button) and a [Popover](https://ui.nuxt.com/docs/components/popover) component to create a color chooser.

```vue [ColorPickerChooserExample.vue]
<script setup lang="ts">
const color = ref('#00C16A')

const chip = computed(() => ({ backgroundColor: color.value }))
</script>

<template>
  <UPopover>
    <UButton label="Choose color" color="neutral" variant="outline">
      <template #leading>
        <span :style="chip" class="size-3 rounded-full" />
      </template>
    </UButton>

    <template #content>
      <UColorPicker v-model="color" class="p-2" />
    </template>
  </UPopover>
</template>
```
