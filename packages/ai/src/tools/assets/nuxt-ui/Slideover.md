# USlideover

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Slideover component
 */
interface SlideoverProps {
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The content of the slideover.
   */
  content?: Omit<DialogContentProps, "as" | "asChild" | "forceMount"> & Partial<EmitsToProps<DialogContentImplEmits>> | undefined;
  /**
   * Render an overlay behind the slideover.
   * @default true
   */
  overlay?: boolean | undefined;
  /**
   * Animate the slideover when opening or closing.
   * @default true
   */
  transition?: boolean | undefined;
  /**
   * The side of the slideover.
   * @default 'right'
   */
  side?: "right" | "top" | "bottom" | "left" | undefined;
  /**
   * Whether to inset the slideover from the edges.
   * @default false
   */
  inset?: boolean | undefined;
  /**
   * Render the slideover in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * Display a close button to dismiss the slideover.
   * `{ size: 'md', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default true
   */
  close?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the close button.
   * @default appConfig.ui.icons.close
   */
  closeIcon?: any;
  /**
   * When `false`, the slideover will not close when clicking outside or pressing escape.
   * @default true
   */
  dismissible?: boolean | undefined;
  ui?: { overlay?: SlotClass; content?: SlotClass; header?: SlotClass; wrapper?: SlotClass; body?: SlotClass; footer?: SlotClass; title?: SlotClass; description?: SlotClass; close?: SlotClass; } | undefined;
  /**
   * The controlled open state of the dialog. Can be binded as `v-model:open`.
   */
  open?: boolean | undefined;
  /**
   * The open state of the dialog when it is initially rendered. Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The modality of the dialog When set to `true`, <br>
   * interaction with outside elements will be disabled and only dialog content will be visible to screen readers.
   * @default true
   */
  modal?: boolean | undefined;
  /**
   * When set to `false`, the dialog content will not be unmounted when closed, but instead hidden with CSS. <br>
   * Useful for SEO or when you want to improve performance by not remounting the component on every open.
   * @default true
   */
  unmountOnHide?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Slideover component
 */
interface SlideoverSlots {
  default(): any;
  content(): any;
  header(): any;
  title(): any;
  description(): any;
  actions(): any;
  close(): any;
  body(): any;
  footer(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Slideover component
 */
interface SlideoverEmits {
  leave: (payload: []) => void;
  after:leave: (payload: []) => void;
  enter: (payload: []) => void;
  after:enter: (payload: []) => void;
  close:prevent: (payload: []) => void;
  update:open: (payload: [value: boolean]) => void;
}
```

## Composition

Parts placed by name: `#content`, `#actions`, `#close`, `#body`.

```vue
<template>
  <USlideover>
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #content>
      <Placeholder class="h-full m-4" />
    </template></USlideover>
</template>
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the Slideover.

Then, use the `#content` slot to add the content displayed when the Slideover is open.

```vue
<template>
  <USlideover>
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #content>
      <Placeholder class="h-full m-4" />
    </template></USlideover>
</template>
```

You can also use the `#header`, `#body` and `#footer` slots to customize the Slideover's content.

### Title

Use the `title` prop to set the title of the Slideover's header.

```vue
<template>
  <USlideover title="Slideover with title">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

### Description

Use the `description` prop to set the description of the Slideover's header.

```vue
<template>
  <USlideover title="Slideover with description" description="Lorem ipsum dolor sit amet, consectetur adipiscing elit.">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

### Close

Use the `close` prop to customize or hide the close button (with `false` value) displayed in the Slideover's header.

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button) component to customize it.

```vue
<template>
  <USlideover title="Slideover with close button" :close="{
  color: 'primary',
  variant: 'outline',
  class: 'rounded-full'
}">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

> [!NOTE]
> 
> The close button is not displayed if the `#content` slot is used as it's a part of the header.

### Close Icon

Use the `close-icon` prop to customize the close button [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-x`.

```vue
<template>
  <USlideover title="Slideover with close button" close-icon="i-lucide-arrow-right">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.close` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.close` key.

### Side

Use the `side` prop to set the side of the screen where the Slideover will slide in from. Defaults to `right`.

```vue
<template>
  <USlideover side="left" title="Slideover with side">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full min-h-48" />
    </template></USlideover>
</template>
```

### Inset `4.3+`

Use the `inset` prop to inset the Slideover from the edges.

```vue
<template>
  <USlideover side="right" inset title="Slideover with inset">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="min-w-96 min-h-96 size-full" />
    </template></USlideover>
</template>
```

### Transition

Use the `transition` prop to control whether the Slideover is animated or not. Defaults to `true`.

```vue
<template>
  <USlideover :transition="false" title="Slideover without transition">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

### Overlay

Use the `overlay` prop to control whether the Slideover has an overlay or not. Defaults to `true`.

```vue
<template>
  <USlideover :overlay="false" title="Slideover without overlay">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

### Modal

Use the `modal` prop to control whether the Slideover blocks interaction with outside content. Defaults to `true`.

> [!NOTE]
> 
> When `modal` is set to `false`, the overlay is automatically disabled and outside content becomes interactive.

```vue
<template>
  <USlideover :modal="false" title="Slideover interactive">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

### Dismissible

Use the `dismissible` prop to control whether the Slideover is dismissible when clicking outside of it or pressing escape. Defaults to `true`.

> [!NOTE]
> 
> A `close:prevent` event will be emitted when the user tries to close it.

> [!TIP]
> 
> You can combine `modal: false` with `dismissible: false` to make the Slideover's background interactive without closing it.

```vue
<template>
  <USlideover :dismissible="false" modal title="Slideover non-dismissible">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

### Unmount `4.10+`

Use the `unmount-on-hide` prop to prevent the Slideover's content from being unmounted when it is closed. Defaults to `true`.

```vue
<template>
  <USlideover :unmount-on-hide="false" title="Slideover">
    <UButton label="Open" color="neutral" variant="subtle" />
  
    <template #body>
      <Placeholder class="h-full" />
    </template></USlideover>
</template>
```

> [!NOTE]
> 

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control open state

You can control the open state by using the `default-open` prop or the `v-model:open` directive.

```vue [SlideoverOpenExample.vue]
<script setup lang="ts">
const open = ref(false)

defineShortcuts({
  o: () => open.value = !open.value
})
</script>

<template>
  <USlideover v-model:open="open">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="h-full m-4" />
    </template>
  </USlideover>
</template>
```

> [!NOTE]
> 
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the Slideover by pressing `O`.

> [!TIP]
> 
> This lets you move the trigger outside of the Slideover or remove it entirely.

### Programmatic usage

You can use the [`useOverlay`](https://ui.nuxt.com/docs/composables/use-overlay) composable to open a Slideover programmatically.

> [!WARNING]
> 
> Make sure to wrap your app with the [`App`](https://ui.nuxt.com/docs/components/app) component which uses the [`OverlayProvider`](https://github.com/nuxt/ui/blob/v4/src/runtime/components/OverlayProvider.vue) component.

First, create a slideover component that will be opened programmatically:

```vue [SlideoverExample.vue]
<script setup lang="ts">
defineProps<{
  count: number
}>()

const emit = defineEmits<{ close: [boolean] }>()
</script>

<template>
  <USlideover :close="{ onClick: () => emit('close', false) }" :description="`This slideover was opened programmatically ${count} times`">
    <template #body>
      <Placeholder class="h-full" />
    </template>

    <template #footer>
      <div class="flex gap-2">
        <UButton color="neutral" label="Dismiss" @click="emit('close', false)" />
        <UButton label="Success" @click="emit('close', true)" />
      </div>
    </template>
  </USlideover>
</template>
```

> [!NOTE]
> 
> We are emitting a `close` event when the slideover is closed or dismissed here. You can emit any data through the `close` event, and that data becomes the resolved value of `open()`. The event must be emitted for the promise to resolve.

Then, use it in your app:

```vue [SlideoverProgrammaticExample.vue]
<script setup lang="ts">
import { LazySlideoverExample } from '#components'

const count = ref(0)

const toast = useToast()
const overlay = useOverlay()

const slideover = overlay.create(LazySlideoverExample)

async function open() {
  const instance = slideover.open({
    count: count.value
  })

  const shouldIncrement = await instance.result

  if (shouldIncrement) {
    count.value++

    toast.add({
      title: `Success: ${shouldIncrement}`,
      color: 'success',
      id: 'slideover-success'
    })

    // Update the count
    slideover.patch({
      count: count.value
    })
    return
  }

  toast.add({
    title: `Dismissed: ${shouldIncrement}`,
    color: 'error',
    id: 'slideover-dismiss'
  })
}
</script>

<template>
  <UButton label="Open" color="neutral" variant="subtle" @click="open" />
</template>
```

> [!TIP]
> 
> You can close the slideover within the slideover component by emitting `emit('close')`.

### Nested slideovers

You can nest slideovers within each other.

```vue [SlideoverNestedExample.vue]
<script setup lang="ts">
const first = ref(false)
const second = ref(false)
</script>

<template>
  <USlideover v-model:open="first" title="First slideover" :ui="{ footer: 'justify-end' }">
    <UButton color="neutral" variant="subtle" label="Open" />

    <template #body>
      <Placeholder class="h-full" />
    </template>

    <template #footer>
      <UButton label="Close" color="neutral" variant="outline" @click="first = false" />

      <USlideover v-model:open="second" title="Second slideover" :ui="{ footer: 'justify-end' }">
        <UButton label="Open second" color="neutral" />

        <template #body>
          <Placeholder class="h-full" />
        </template>

        <template #footer>
          <UButton label="Close" color="neutral" variant="outline" @click="second = false" />
        </template>
      </USlideover>
    </template>
  </USlideover>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
