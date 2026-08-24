# UCollapsible

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Collapsible component
 */
interface CollapsibleProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?: { root?: SlotClass; content?: SlotClass } | undefined;
  /**
   * When `true`, prevents the user from interacting with the collapsible.
   */
  disabled?: boolean | undefined;
  /**
   * The open state of the collapsible when it is initially rendered. <br> Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The controlled open state of the collapsible. Can be binded with `v-model`.
   */
  open?: boolean | undefined;
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
 * Slots for the Collapsible component
 */
interface CollapsibleSlots {
  default(): any;
  content(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Collapsible component
 */
interface CollapsibleEmits {
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the Collapsible.

Then, use the `#content` slot to add the content displayed when the Collapsible is open.

```vue
<template>
  <UCollapsible class="flex flex-col gap-2 w-48">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-down"
      block />

    <template #content>
      <Placeholder class="h-48" /> </template
  ></UCollapsible>
</template>
```

### Unmount

Use the `unmount-on-hide` prop to prevent the content from being unmounted when the Collapsible is collapsed. Defaults to `true`.

```vue
<template>
  <UCollapsible :unmount-on-hide="false" class="flex flex-col gap-2 w-48">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-down"
      block />

    <template #content>
      <Placeholder class="h-48" /> </template
  ></UCollapsible>
</template>
```

> \[!NOTE]
>
> You can inspect the DOM to see the content being rendered.

### Disabled

Use the `disabled` prop to disable the Collapsible.

```vue
<template>
  <UCollapsible class="flex flex-col gap-2 w-48" disabled>
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-down"
      block />

    <template #content>
      <Placeholder class="h-48" /> </template
  ></UCollapsible>
</template>
```

## Examples

### Control open state

You can control the open state by using the `default-open` prop or the `v-model:open` directive.

```vue [CollapsibleOpenExample.vue]
<script setup lang="ts">
const open = ref(true);

defineShortcuts({
  o: () => (open.value = !open.value),
});
</script>

<template>
  <UCollapsible v-model:open="open" class="flex flex-col gap-2 w-48">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-down"
      block
    />

    <template #content>
      <Placeholder class="h-48" />
    </template>
  </UCollapsible>
</template>
```

> \[!NOTE]
>
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the Collapsible by pressing :kbd{value="O"}.

> \[!TIP]
>
> This lets you move the trigger outside of the Collapsible or remove it entirely.

### With rotating icon

Here is an example with a rotating icon in the Button that indicates the open state of the Collapsible.

```vue [CollapsibleIconExample.vue]
<template>
  <UCollapsible class="flex flex-col gap-2 w-48">
    <UButton
      class="group"
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-down"
      :ui="{
        trailingIcon:
          'group-data-[state=open]:rotate-180 transition-transform duration-200',
      }"
      block
    />

    <template #content>
      <Placeholder class="h-48" />
    </template>
  </UCollapsible>
</template>
```
