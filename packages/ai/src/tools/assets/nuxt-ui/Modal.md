# UModal

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Modal component
 */
interface ModalProps {
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The content of the modal.
   */
  content?:
    | (Omit<DialogContentProps, "as" | "asChild" | "forceMount"> &
        Partial<EmitsToProps<DialogContentImplEmits>>)
    | undefined;
  /**
   * Render an overlay behind the modal.
   * @default true
   */
  overlay?: boolean | undefined;
  /**
   * When `true`, enables scrollable overlay mode where content scrolls within the overlay.
   * @default false
   */
  scrollable?: boolean | undefined;
  /**
   * Animate the modal when opening or closing.
   * @default true
   */
  transition?: boolean | undefined;
  /**
   * When `true`, the modal will take up the full screen.
   * @default false
   */
  fullscreen?: boolean | undefined;
  /**
   * Render the modal in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * Display a close button to dismiss the modal.
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
   * When `false`, the modal will not close when clicking outside or pressing escape.
   * @default true
   */
  dismissible?: boolean | undefined;
  ui?:
    | {
        overlay?: SlotClass;
        content?: SlotClass;
        header?: SlotClass;
        wrapper?: SlotClass;
        body?: SlotClass;
        footer?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        close?: SlotClass;
      }
    | undefined;
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
 * Slots for the Modal component
 */
interface ModalSlots {
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
 * Emitted events for the Modal component
 */
interface ModalEmits {
  leave: (payload: []) => void;
  after:leave: (payload: []) => void;
  enter: (payload: []) => void;
  after:enter: (payload: []) => void;
  close:prevent: (payload: []) => void;
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the Modal.

Then, use the `#content` slot to add the content displayed when the Modal is open.

```vue
<template>
  <UModal>
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UModal>
</template>
```

You can also use the `#header`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}, `#body`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} and `#footer`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} slots to customize the Modal's content.

### Title

Use the `title` prop to set the title of the Modal's header.

```vue
<template>
  <UModal title="Modal with title">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

### Description

Use the `description` prop to set the description of the Modal's header.

```vue
<template>
  <UModal
    title="Modal with description"
    description="Lorem ipsum dolor sit amet, consectetur adipiscing elit."
  >
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

### Close

Use the `close` prop to customize or hide the close button (with `false` value) displayed in the Modal's header.

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button) component to customize it.

```vue
<template>
  <UModal
    title="Modal with close button"
    :close="{
      color: 'primary',
      variant: 'outline',
      class: 'rounded-full',
    }"
  >
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

> \[!TIP]
>
> The close button is not displayed if the `#content` slot is used as it's a part of the header.

### Close Icon

Use the `close-icon` prop to customize the close button [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-x`.

```vue
<template>
  <UModal title="Modal with close button" close-icon="i-lucide-arrow-right">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize this icon globally in your `app.config.ts` under `ui.icons.close` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.close` key.

### Transition

Use the `transition` prop to control whether the Modal is animated or not. Defaults to `true`.

```vue
<template>
  <UModal :transition="false" title="Modal without transition">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

### Overlay

Use the `overlay` prop to control whether the Modal has an overlay or not. Defaults to `true`.

```vue
<template>
  <UModal :overlay="false" title="Modal without overlay">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

### Modal

Use the `modal` prop to control whether the Modal blocks interaction with outside content. Defaults to `true`.

> \[!NOTE]
>
> When `modal` is set to `false`, the overlay is automatically disabled and outside content becomes interactive.

```vue
<template>
  <UModal :modal="false" title="Modal interactive">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

### Dismissible

Use the `dismissible` prop to control whether the Modal is dismissible when clicking outside of it or pressing escape. Defaults to `true`.

> \[!NOTE]
>
> A `close:prevent` event will be emitted when the user tries to close it.

> \[!TIP]
>
> You can combine `modal: false` with `dismissible: false` to make the Modal's background interactive without closing it.

```vue
<template>
  <UModal :dismissible="false" modal title="Modal non-dismissible">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

### Scrollable `4.2+`

Use the `scrollable` prop to make the Modal's content scrollable within the overlay.

> \[!WARNING]
>
> As the overlay is needed for scrolling, `modal: false` is not compatible and `overlay: false` only removes the background.

```vue
<template>
  <UModal scrollable overlay title="Modal scrollable">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-full" /> </template
  ></UModal>
</template>
```

> \[!CAUTION]
>
> There's a [known issue](https://reka-ui.com/docs/components/dialog#scrollable-overlay){rel="&#x22;nofollow&#x22;"} where clicking on the scrollbar may unintentionally close the dialog on some operating systems.

### Fullscreen

Use the `fullscreen` prop to make the Modal fullscreen.

```vue
<template>
  <UModal fullscreen title="Modal fullscreen">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-full" /> </template
  ></UModal>
</template>
```

### Unmount `4.10+`

Use the `unmount-on-hide` prop to prevent the Modal's content from being unmounted when it is closed. Defaults to `true`.

```vue
<template>
  <UModal :unmount-on-hide="false" title="Modal">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UModal>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control open state

You can control the open state by using the `default-open` prop or the `v-model:open` directive.

```vue [ModalOpenExample.vue]
<script setup lang="ts">
const open = ref(false);

defineShortcuts({
  o: () => (open.value = !open.value),
});
</script>

<template>
  <UModal v-model:open="open">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="h-48 m-4" />
    </template>
  </UModal>
</template>
```

> \[!NOTE]
>
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the Modal by pressing :kbd{value="O"}.

> \[!TIP]
>
> This lets you move the trigger outside of the Modal or remove it entirely.

### Programmatic usage

You can use the [`useOverlay`](https://ui.nuxt.com/docs/composables/use-overlay) composable to open a Modal programmatically.

> \[!WARNING]
>
> Make sure to wrap your app with the [`App`](https://ui.nuxt.com/docs/components/app) component which uses the [`OverlayProvider`](https://github.com/nuxt/ui/blob/v4/src/runtime/components/OverlayProvider.vue){rel="&#x22;nofollow&#x22;"} component.

First, create a modal component that will be opened programmatically:

```vue [ModalExample.vue]
<script setup lang="ts">
defineProps<{
  count: number;
}>();

const emit = defineEmits<{ close: [boolean] }>();
</script>

<template>
  <UModal
    :close="{ onClick: () => emit('close', false) }"
    :title="`This modal was opened programmatically ${count} times`"
  >
    <template #footer>
      <div class="flex gap-2">
        <UButton
          color="neutral"
          label="Dismiss"
          @click="emit('close', false)"
        />
        <UButton label="Success" @click="emit('close', true)" />
      </div>
    </template>
  </UModal>
</template>
```

> \[!NOTE]
>
> We are emitting a `close` event when the modal is closed or dismissed here. You can emit any data through the `close` event, and that data becomes the resolved value of `open()`. The event must be emitted for the promise to resolve.

Then, use it in your app:

```vue [ModalProgrammaticExample.vue]
<script setup lang="ts">
import { LazyModalExample } from "#components";

const count = ref(0);

const toast = useToast();
const overlay = useOverlay();

const modal = overlay.create(LazyModalExample);

async function open() {
  const instance = modal.open({
    count: count.value,
  });

  const shouldIncrement = await instance.result;

  if (shouldIncrement) {
    count.value++;

    toast.add({
      title: `Success: ${shouldIncrement}`,
      color: "success",
      id: "modal-success",
    });

    // Update the count
    modal.patch({
      count: count.value,
    });
    return;
  }

  toast.add({
    title: `Dismissed: ${shouldIncrement}`,
    color: "error",
    id: "modal-dismiss",
  });
}
</script>

<template>
  <UButton label="Open" color="neutral" variant="subtle" @click="open" />
</template>
```

> \[!TIP]
>
> You can close the modal within the modal component by emitting `emit('close')`.

### Nested modals

You can nest modals within each other.

```vue [ModalNestedExample.vue]
<script setup lang="ts">
const first = ref(false);
const second = ref(false);
</script>

<template>
  <UModal
    v-model:open="first"
    title="First modal"
    :ui="{ footer: 'justify-end' }"
  >
    <UButton color="neutral" variant="subtle" label="Open" />

    <template #footer>
      <UButton
        label="Close"
        color="neutral"
        variant="outline"
        @click="first = false"
      />

      <UModal
        v-model:open="second"
        title="Second modal"
        :ui="{ footer: 'justify-end' }"
      >
        <UButton label="Open second" color="neutral" />

        <template #footer>
          <UButton
            label="Close"
            color="neutral"
            variant="outline"
            @click="second = false"
          />
        </template>
      </UModal>
    </template>
  </UModal>
</template>
```

### With footer slot

Use the `#footer` slot to add content after the Modal's body.

```vue [ModalFooterSlotExample.vue]
<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <UModal
    v-model:open="open"
    title="Modal with footer"
    description="This is useful when you want a form in a Modal."
    :ui="{ footer: 'justify-end' }"
  >
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #body>
      <Placeholder class="h-48" />
    </template>

    <template #footer="{ close }">
      <UButton
        label="Cancel"
        color="neutral"
        variant="outline"
        @click="close"
      />
      <UButton label="Submit" color="neutral" />
    </template>
  </UModal>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
