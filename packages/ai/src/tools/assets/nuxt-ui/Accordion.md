# UAccordion

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Accordion component
 */
interface AccordionProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  items?: T[] | undefined;
  /**
   * The icon displayed on the right side of the trigger.
   * @default appConfig.ui.icons.chevronDown
   */
  trailingIcon?: any;
  /**
   * The key used to get the value from the item.
   * @default 'value'
   */
  valueKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  ui?:
    | {
        root?: SlotClass;
        item?: SlotClass;
        header?: SlotClass;
        trigger?: SlotClass;
        content?: SlotClass;
        body?: SlotClass;
        leadingIcon?: SlotClass;
        trailingIcon?: SlotClass;
        label?: SlotClass;
      }
    | undefined;
  /**
   * When type is "single", allows closing content when clicking trigger for an open item.
   * When type is "multiple", this prop has no effect.
   * @default true
   */
  collapsible?: boolean | undefined;
  /**
   * The default active value of the item(s).
   *
   * Use when you do not need to control the state of the item(s).
   */
  defaultValue?: string | string[] | undefined;
  /**
   * The controlled value of the active item(s).
   *
   * Use this when you need to control the state of the items. Can be binded with `v-model`
   */
  modelValue?: string | string[] | undefined;
  /**
   * Determines whether a "single" or "multiple" items can be selected at a time.
   *
   * This prop will overwrite the inferred type from `modelValue` and `defaultValue`.
   * @default 'single'
   */
  type?: "single" | "multiple" | undefined;
  /**
   * When `true`, prevents the user from interacting with the accordion and all its items
   * @default false
   */
  disabled?: boolean | undefined;
  /**
   * When `true`, the element will be unmounted on closed state.
   * @default true
   */
  unmountOnHide?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Accordion component
 */
interface AccordionSlots {
  default(): any;
  leading(): any;
  trailing(): any;
  content(): any;
  body(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Accordion component
 */
interface AccordionEmits {
  update:modelValue: (payload: [value: string | string[] | undefined]) => void;
}
```

## Usage

Use the Accordion component to display a list of collapsible items.

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Is Nuxt UI free to use?",
    content:
      "Yes! Nuxt UI is completely free and open source under the MIT license. All 125+ components are available to everyone.",
  },
  {
    label: "Can I use Nuxt UI with Vue without Nuxt?",
    content:
      "Yes! While optimized for Nuxt, Nuxt UI works perfectly with standalone Vue projects via our Vite plugin. You can follow the [installation guide](/docs/getting-started/installation/vue) to get started.",
  },
  {
    label: "Is Nuxt UI production-ready?",
    content:
      "Yes! Nuxt UI is used in production by thousands of applications with extensive tests, regular updates, and active maintenance.",
  },
]);
</script>

<template>
  <UAccordion :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `trailingIcon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `content?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `value?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-custom-slot)
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, header?: ClassNameValue, trigger?: ClassNameValue, leadingIcon?: ClassNameValue, label?: ClassNameValue, trailingIcon?: ClassNameValue, content?: ClassNameValue, body?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);
</script>

<template>
  <UAccordion :items="items" />
</template>
```

### Multiple

Set the `type` prop to `multiple` to allow multiple items to be active at the same time. Defaults to `single`.

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);
</script>

<template>
  <UAccordion type="multiple" :items="items" />
</template>
```

### Collapsible

When `type` is `single`, you can set the `collapsible` prop to `false` to prevent the active item from collapsing.

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);
</script>

<template>
  <UAccordion :collapsible="false" :items="items" />
</template>
```

### Unmount

Use the `unmount-on-hide` prop to prevent the content from being unmounted when the accordion is collapsed. Defaults to `true`.

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);
</script>

<template>
  <UAccordion :unmount-on-hide="false" :items="items" />
</template>
```

> \[!NOTE]
>
> You can inspect the DOM to see each item's content being rendered.

### Disabled

Use the `disabled` property to disable the Accordion.

You can also disable a specific item by using the `disabled` property in the item object.

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
    disabled: true,
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);
</script>

<template>
  <UAccordion disabled :items="items" />
</template>
```

### Trailing Icon

Use the `trailing-icon` prop to customize the trailing [Icon](https://ui.nuxt.com/docs/components/icon) of each item. Defaults to `i-lucide-chevron-down`.

> \[!TIP]
>
> You can also set an icon for a specific item by using the `trailingIcon` property in the item object.

```vue
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items = ref<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
    trailingIcon: "i-lucide-plus",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);
</script>

<template>
  <UAccordion trailing-icon="i-lucide-arrow-down" :items="items" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control active item(s)

You can control the active item by using the `default-value` prop or the `v-model` directive with the `value` of the item. If no `value` is provided, it defaults to the index **as a string**.

```vue [AccordionModelValueExample.vue]
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items: AccordionItem[] = [
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
];

const active = ref("0");

// Note: This is for demonstration purposes only. Don't do this at home.
onMounted(() => {
  setInterval(() => {
    active.value = String((Number(active.value) + 1) % items.length);
  }, 2000);
});
</script>

<template>
  <UAccordion v-model="active" :items="items" />
</template>
```

> \[!TIP]
>
> Use the `value-key` prop to change the key used to match items when a `v-model` or `default-value` is provided.

> \[!CAUTION]
>
> When `type="multiple"`, ensure to pass an array to the `default-value` prop or the `v-model` directive.

### With drag and drop

Use the [`useSortable`](https://vueuse.org/integrations/useSortable/){rel="&#x22;nofollow&#x22;"} composable from [`@vueuse/integrations`](https://vueuse.org/integrations/README.html){rel="&#x22;nofollow&#x22;"} to enable drag and drop functionality on the Accordion. This integration wraps [Sortable.js](https://sortablejs.github.io/Sortable/){rel="&#x22;nofollow&#x22;"} to provide a seamless drag and drop experience.

```vue [AccordionDragAndDropExample.vue]
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";
import { useSortable } from "@vueuse/integrations/useSortable";

const items = shallowRef<AccordionItem[]>([
  {
    label: "Icons",
    icon: "i-lucide-smile",
    content: "You have nothing to do, @nuxt/icon will handle it automatically.",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
    content:
      "Choose a primary and a neutral color from your Tailwind CSS theme.",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    content:
      "You can customize components by using the `class` / `ui` props or in your app.config.ts.",
  },
]);

const accordion = useTemplateRef<HTMLElement>("accordion");

useSortable(accordion, items, {
  animation: 150,
});
</script>

<template>
  <UAccordion ref="accordion" :items="items" />
</template>
```

### With body slot

Use the `#body` slot to customize the body of each item.

```vue [AccordionBodySlotExample.vue]
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items: AccordionItem[] = [
  {
    label: "Icons",
    icon: "i-lucide-smile",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
  },
];
</script>

<template>
  <UAccordion :items="items">
    <template #body="{ item }"> This is the {{ item.label }} panel. </template>
  </UAccordion>
</template>
```

> \[!TIP]
>
> The `#body` slot includes some pre-defined styles, use the [`#content` slot](https://ui.nuxt.com/#with-content-slot) if you want to start from scratch.

### With content slot

Use the `#content` slot to customize the content of each item.

```vue [AccordionContentSlotExample.vue]
<script setup lang="ts">
import type { AccordionItem } from "@nuxt/ui";

const items: AccordionItem[] = [
  {
    label: "Icons",
    icon: "i-lucide-smile",
  },
  {
    label: "Colors",
    icon: "i-lucide-swatch-book",
  },
  {
    label: "Components",
    icon: "i-lucide-box",
  },
];
</script>

<template>
  <UAccordion :items="items">
    <template #content="{ item }">
      <p class="pb-3.5 text-sm text-muted">
        This is the {{ item.label }} panel.
      </p>
    </template>
  </UAccordion>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
