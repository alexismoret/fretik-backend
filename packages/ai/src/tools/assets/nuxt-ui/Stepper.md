# UStepper

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Stepper component
 */
interface StepperProps {
  items: T[];
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
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
   * The orientation of the stepper.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * The key used to get the value from the item.
   * @default 'value'
   */
  valueKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  /**
   * The value of the step that should be active when initially rendered. Use when you do not need to control the state of the steps.
   */
  defaultValue?: string | number | undefined;
  disabled?: boolean | undefined;
  ui?:
    | {
        root?: SlotClass;
        header?: SlotClass;
        item?: SlotClass;
        container?: SlotClass;
        trigger?: SlotClass;
        indicator?: SlotClass;
        icon?: SlotClass;
        separator?: SlotClass;
        wrapper?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        content?: SlotClass;
      }
    | undefined;
  /**
   * Whether or not the steps must be completed in order.
   * @default true
   */
  linear?: boolean | undefined;
  modelValue?: string | number | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Stepper component
 */
interface StepperSlots {
  indicator(): any;
  wrapper(): any;
  title(): any;
  description(): any;
  content(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Stepper component
 */
interface StepperEmits {
  next: (payload: [value: T]) => void;
  prev: (payload: [value: T]) => void;
  update:modelValue: (payload: [value: string | number | undefined]) => void;
}
```

### Expose

You can access the typed component instance using [`useTemplateRef`](https://vuejs.org/api/composition-api-helpers.html#usetemplateref){rel="&#x22;nofollow&#x22;"}.

```vue
<script setup lang="ts">
const stepper = useTemplateRef("stepper");
</script>

<template>
  <UStepper ref="stepper" />
</template>
```

This will give you access to the following:

| Name                                                                                                                          | Type                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `next`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"}    | `() => void`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"}   |
| `prev`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"}    | `() => void`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"}   |
| `hasNext`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<boolean>`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |
| `hasPrev`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<boolean>`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |

## Usage

Use the Stepper component to display a list of items in a stepper.

```vue
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = ref<StepperItem[]>([
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
]);
</script>

<template>
  <UStepper :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `title?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `description?: AvatarProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `content?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `value?: string | number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-custom-slot)
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, container?: ClassNameValue, trigger?: ClassNameValue, indicator?: ClassNameValue, icon?: ClassNameValue, separator?: ClassNameValue, wrapper?: ClassNameValue, title?: ClassNameValue, description?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = ref<StepperItem[]>([
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
]);
</script>

<template>
  <UStepper :items="items" class="w-full" />
</template>
```

> \[!NOTE]
>
> Click on the items to navigate through the steps.

### Color

Use the `color` prop to change the color of the Stepper.

```vue
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = ref<StepperItem[]>([
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
]);
</script>

<template>
  <UStepper color="neutral" :items="items" class="w-full" />
</template>
```

### Size

Use the `size` prop to change the size of the Stepper.

```vue
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = ref<StepperItem[]>([
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
]);
</script>

<template>
  <UStepper size="xl" :items="items" class="w-full" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the Stepper. Defaults to `horizontal`.

```vue
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = ref<StepperItem[]>([
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
]);
</script>

<template>
  <UStepper orientation="vertical" :items="items" class="w-full" />
</template>
```

### Disabled

Use the `disabled` prop to disable navigation through the steps.

```vue
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = ref<StepperItem[]>([
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
]);
</script>

<template>
  <UStepper disabled :items="items" />
</template>
```

> \[!NOTE]
> See: #with-controls
>
> This can be useful when you want to force navigation with controls.

## Examples

### With controls

You can add additional controls for the stepper using buttons.

```vue [StepperWithControlsExample.vue]
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items: StepperItem[] = [
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
];

const stepper = useTemplateRef("stepper");
</script>

<template>
  <div class="w-full">
    <UStepper ref="stepper" :items="items">
      <template #content="{ item }">
        <Placeholder class="aspect-video">
          {{ item.title }}
        </Placeholder>
      </template>
    </UStepper>

    <div class="flex gap-2 justify-between mt-4">
      <UButton
        leading-icon="i-lucide-arrow-left"
        :disabled="!stepper?.hasPrev"
        @click="stepper?.prev()"
      >
        Prev
      </UButton>

      <UButton
        trailing-icon="i-lucide-arrow-right"
        :disabled="!stepper?.hasNext"
        @click="stepper?.next()"
      >
        Next
      </UButton>
    </div>
  </div>
</template>
```

### Control active item

You can control the active item by using the `default-value` prop or the `v-model` directive with the `value` of the item. If no `value` is provided, it defaults to the index.

```vue [StepperModelValueExample.vue]
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";
import { onMounted, ref } from "vue";

const items: StepperItem[] = [
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
];

const active = ref(0);

// Note: This is for demonstration purposes only. Don't do this at home.
onMounted(() => {
  setInterval(() => {
    active.value = (active.value + 1) % items.length;
  }, 2000);
});
</script>

<template>
  <UStepper v-model="active" :items="items" class="w-full">
    <template #content="{ item }">
      <Placeholder class="aspect-video">
        This is the {{ item?.title }} step.
      </Placeholder>
    </template>
  </UStepper>
</template>
```

> \[!TIP]
>
> Use the `value-key` prop to change the key used to match items when a `v-model` or `default-value` is provided.

### With content slot

Use the `#content` slot to customize the content of each item.

```vue [StepperContentSlotExample.vue]
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items: StepperItem[] = [
  {
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    title: "Checkout",
    description: "Confirm your order",
  },
];
</script>

<template>
  <UStepper ref="stepper" :items="items" class="w-full">
    <template #content="{ item }">
      <Placeholder class="aspect-video">
        This is the {{ item?.title }} step.
      </Placeholder>
    </template>
  </UStepper>
</template>
```

### With custom slot

Use the `slot` property to customize a specific item.

You will have access to the following slots:

- `#{{ item.slot }}`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue [StepperCustomSlotExample.vue]
<script setup lang="ts">
import type { StepperItem } from "@nuxt/ui";

const items = [
  {
    slot: "address" as const,
    title: "Address",
    description: "Add your address here",
    icon: "i-lucide-house",
  },
  {
    slot: "shipping" as const,
    title: "Shipping",
    description: "Set your preferred shipping method",
    icon: "i-lucide-truck",
  },
  {
    slot: "checkout" as const,
    title: "Checkout",
    description: "Confirm your order",
  },
] satisfies StepperItem[];
</script>

<template>
  <UStepper :items="items" class="w-full">
    <template #address>
      <Placeholder class="aspect-video"> Address </Placeholder>
    </template>

    <template #shipping>
      <Placeholder class="aspect-video"> Shipping </Placeholder>
    </template>

    <template #checkout>
      <Placeholder class="aspect-video"> Checkout </Placeholder>
    </template>
  </UStepper>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
