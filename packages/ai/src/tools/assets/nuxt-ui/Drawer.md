# UDrawer

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Drawer component
 */
interface DrawerProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Whether to inset the drawer from the edges.
   * @default false
   */
  inset?: boolean | undefined;
  /**
   * The content of the drawer.
   */
  content?:
    | (Omit<DialogContentProps, "as" | "asChild" | "forceMount"> &
        Partial<EmitsToProps<DialogContentImplEmits>>)
    | undefined;
  /**
   * Render an overlay behind the drawer.
   * @default true
   */
  overlay?: boolean | undefined;
  /**
   * Render a handle on the drawer.
   * @default true
   */
  handle?: boolean | undefined;
  /**
   * Render the drawer in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * Whether the drawer is nested in another drawer.
   * @default false
   */
  nested?: boolean | undefined;
  /**
   * Display a close button to dismiss the drawer.
   * `{ size: 'md', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default false
   */
  close?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the close button.
   * @default appConfig.ui.icons.close
   */
  closeIcon?: any;
  ui?:
    | {
        overlay?: SlotClass;
        content?: SlotClass;
        handle?: SlotClass;
        container?: SlotClass;
        header?: SlotClass;
        wrapper?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        actions?: SlotClass;
        body?: SlotClass;
        footer?: SlotClass;
        close?: SlotClass;
      }
    | undefined;
  activeSnapPoint?: null | string | number | undefined;
  /**
   * Number between 0 and 1 that determines when the drawer should be closed.
   * Example: threshold of 0.5 would close the drawer if the user swiped for 50% of the height of the drawer or more.
   */
  closeThreshold?: number | undefined;
  shouldScaleBackground?: boolean | undefined;
  /**
   * When `false` we don't change body's background color when the drawer is open.
   */
  setBackgroundColorOnScale?: boolean | undefined;
  /**
   * Duration for which the drawer is not draggable after scrolling content inside of the drawer.
   */
  scrollLockTimeout?: number | undefined;
  /**
   * When `true`, don't move the drawer upwards if there's space, but rather only change it's height so it's fully scrollable when the keyboard is open
   */
  fixed?: boolean | undefined;
  /**
   * When `false` dragging, clicking outside, pressing esc, etc. will not close the drawer.
   * Use this in combination with the `open` prop, otherwise you won't be able to open/close the drawer.
   * @default true
   */
  dismissible?: boolean | undefined;
  /**
   * When `false` it allows to interact with elements outside of the drawer without closing it.
   * @default true
   */
  modal?: boolean | undefined;
  open?: boolean | undefined;
  /**
   * Opened by default, skips initial enter animation. Still reacts to `open` state changes
   */
  defaultOpen?: boolean | undefined;
  /**
   * Direction of the drawer. Can be `top` or `bottom`, `left`, `right`.
   * @default 'bottom'
   */
  direction?: "bottom" | "top" | "left" | "right" | undefined;
  /**
   * When `true` the `body` doesn't get any styles assigned from Vaul
   */
  noBodyStyles?: boolean | undefined;
  /**
   * When `true` only allows the drawer to be dragged by the `<Drawer.Handle />` component.
   */
  handleOnly?: boolean | undefined;
  preventScrollRestoration?: boolean | undefined;
  /**
   * Array of numbers from 0 to 100 that corresponds to % of the screen a given snap point should take up.
   * Should go from least visible. Example `[0.2, 0.5, 0.8]`.
   * You can also use px values, which doesn't take screen height into account.
   */
  snapPoints?: (string | number)[] | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Drawer component
 */
interface DrawerSlots {
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
 * Emitted events for the Drawer component
 */
interface DrawerEmits {
  close: (payload: []) => void;
  drag: (payload: [percentageDragged: number]) => void;
  close:prevent: (payload: []) => void;
  release: (payload: [open: boolean]) => void;
  update:open: (payload: [open: boolean]) => void;
  update:activeSnapPoint: (payload: [val: string | number]) => void;
  animationEnd: (payload: [open: boolean]) => void;
}
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the Drawer.

Then, use the `#content` slot to add the content displayed when the Drawer is open.

```vue
<template>
  <UDrawer>
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UDrawer>
</template>
```

You can also use the `#header`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}, `#body`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} and `#footer`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} slots to customize the Drawer's content.

### Title

Use the `title` prop to set the title of the Drawer's header.

```vue
<template>
  <UDrawer title="Drawer with title">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UDrawer>
</template>
```

### Description

Use the `description` prop to set the description of the Drawer's header.

```vue
<template>
  <UDrawer
    title="Drawer with description"
    description="Lorem ipsum dolor sit amet, consectetur adipiscing elit."
  >
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UDrawer>
</template>
```

### Close `4.10+`

Use the `close` prop to display a close button in the Drawer. Defaults to `false`.

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button) component to customize it.

```vue
<template>
  <UDrawer
    title="Drawer with close button"
    :close="{
      color: 'primary',
      variant: 'outline',
      class: 'rounded-full',
    }"
  >
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UDrawer>
</template>
```

### Close Icon `4.10+`

Use the `close-icon` prop to customize the close button [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-x`.

```vue
<template>
  <UDrawer
    title="Drawer with close button"
    close
    close-icon="i-lucide-arrow-right"
  >
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #body>
      <Placeholder class="h-48" /> </template
  ></UDrawer>
</template>
```

### Direction

Use the `direction` prop to control the direction of the Drawer. Defaults to `bottom`.

```vue
<template>
  <UDrawer direction="right">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="min-w-96 min-h-96 size-full m-4" /> </template
  ></UDrawer>
</template>
```

### Inset

Use the `inset` prop to inset the Drawer from the edges.

```vue
<template>
  <UDrawer direction="right" inset>
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="min-w-96 min-h-96 size-full m-4" /> </template
  ></UDrawer>
</template>
```

### Handle

Use the `handle` prop to control whether the Drawer has a handle or not. Defaults to `true`.

```vue
<template>
  <UDrawer :handle="false">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UDrawer>
</template>
```

### Handle Only

Use the `handle-only` prop to only allow the Drawer to be dragged by the handle.

```vue
<template>
  <UDrawer handle-only>
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UDrawer>
</template>
```

### Overlay

Use the `overlay` prop to control whether the Drawer has an overlay or not. Defaults to `true`.

```vue
<template>
  <UDrawer :overlay="false">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UDrawer>
</template>
```

### Modal

Use the `modal` prop to control whether the Drawer blocks interaction with outside content. Defaults to `true`.

> \[!NOTE]
>
> When `modal` is set to `false`, the overlay is automatically disabled and outside content becomes interactive.

```vue
<template>
  <UDrawer :modal="false">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UDrawer>
</template>
```

### Dismissible

Use the `dismissible` prop to control whether the Drawer is dismissible when clicking outside of it or pressing escape. Defaults to `true`.

> \[!NOTE]
>
> A `close:prevent` event will be emitted when the user tries to close it.

> \[!TIP]
>
> You can combine `modal: false` with `dismissible: false` to make the Drawer's background interactive without closing it.

```vue [DrawerDismissibleExample.vue]
<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <UDrawer
    v-model:open="open"
    title="Drawer non-dismissible"
    close
    :dismissible="false"
    :modal="false"
    :handle="false"
  >
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up"
    />

    <template #body>
      <Placeholder class="size-full min-h-48" />
    </template>
  </UDrawer>
</template>
```

### Scale Background

Use the `should-scale-background` prop to scale the background when the Drawer is open, creating a visual depth effect. You can set the `set-background-color-on-scale` prop to `false` to prevent changing the background color.

```vue
<template>
  <UDrawer should-scale-background set-background-color-on-scale>
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up" />

    <template #content>
      <Placeholder class="h-48 m-4" /> </template
  ></UDrawer>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control open state

You can control the open state by using the `default-open` prop or the `v-model:open` directive.

```vue [DrawerOpenExample.vue]
<script setup lang="ts">
const open = ref(false);

defineShortcuts({
  o: () => (open.value = !open.value),
});
</script>

<template>
  <UDrawer v-model:open="open">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up"
    />

    <template #content>
      <Placeholder class="h-48 m-4" />
    </template>
  </UDrawer>
</template>
```

> \[!NOTE]
>
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the Drawer by pressing :kbd{value="O"}.

> \[!TIP]
>
> This allows you to move the trigger outside of the Drawer or remove it entirely.

### Responsive drawer

You can render a [Modal](https://ui.nuxt.com/docs/components/modal) component on desktop and a Drawer on mobile for example.

```vue [DrawerResponsiveExample.vue]
<script lang="ts" setup>
import { createReusableTemplate, useMediaQuery } from "@vueuse/core";

const [DefineFormTemplate, ReuseFormTemplate] = createReusableTemplate();
const isDesktop = useMediaQuery("(min-width: 768px)");

const open = ref(false);

const state = reactive({
  email: undefined,
});

const title = "Edit profile";
const description =
  "Make changes to your profile here. Click save when you're done.";
</script>

<template>
  <DefineFormTemplate>
    <UForm :state="state" class="space-y-4">
      <UFormField label="Email" name="email" required>
        <UInput
          v-model="state.email"
          placeholder="shadcn@example.com"
          required
        />
      </UFormField>

      <UButton label="Save changes" type="submit" />
    </UForm>
  </DefineFormTemplate>

  <UModal
    v-if="isDesktop"
    v-model:open="open"
    :title="title"
    :description="description"
  >
    <UButton label="Edit profile" color="neutral" variant="outline" />

    <template #body>
      <ReuseFormTemplate />
    </template>
  </UModal>

  <UDrawer v-else v-model:open="open" :title="title" :description="description">
    <UButton label="Edit profile" color="neutral" variant="outline" />

    <template #body>
      <ReuseFormTemplate />
    </template>
  </UDrawer>
</template>
```

### Nested drawers

You can nest drawers within each other by using the `nested` prop.

```vue [DrawerNestedExample.vue]
<template>
  <UDrawer :ui="{ content: 'h-full', overlay: 'bg-inverted/30' }">
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up"
    />

    <template #footer>
      <UDrawer nested :ui="{ content: 'h-full', overlay: 'bg-inverted/30' }">
        <UButton color="neutral" variant="outline" label="Open nested" />

        <template #content>
          <Placeholder class="flex-1 m-4" />
        </template>
      </UDrawer>
    </template>
  </UDrawer>
</template>
```

### With footer slot

Use the `#footer` slot to add content after the Drawer's body.

```vue [DrawerFooterSlotExample.vue]
<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <UDrawer
    v-model:open="open"
    title="Drawer with footer"
    description="This is useful when you want a form in a Drawer."
    :ui="{ container: 'max-w-xl mx-auto' }"
  >
    <UButton
      label="Open"
      color="neutral"
      variant="subtle"
      trailing-icon="i-lucide-chevron-up"
    />

    <template #body>
      <Placeholder class="h-48" />
    </template>

    <template #footer>
      <UButton label="Submit" color="neutral" class="justify-center" />
      <UButton
        label="Cancel"
        color="neutral"
        variant="outline"
        class="justify-center"
        @click="open = false"
      />
    </template>
  </UDrawer>
</template>
```

### With command palette

You can use a [CommandPalette](https://ui.nuxt.com/docs/components/command-palette) component inside the Drawer's content.

```vue [DrawerCommandPaletteExample.vue]
<script setup lang="ts">
const searchTerm = ref("");

const {
  data: users,
  status,
  execute,
} = await useLazyFetch("https://jsonplaceholder.typicode.com/users", {
  key: "drawer-command-palette-users",
  params: { q: searchTerm },
  transform: (data: { id: number; name: string; email: string }[]) => {
    return (
      data?.map((user) => ({
        id: user.id,
        label: user.name,
        suffix: user.email,
        avatar: {
          src: `https://i.pravatar.cc/120?img=${user.id}`,
          loading: "lazy" as const,
        },
      })) || []
    );
  },
  immediate: false,
});

const groups = computed(() => [
  {
    id: "users",
    label: searchTerm.value
      ? `Users matching “${searchTerm.value}”...`
      : "Users",
    items: users.value || [],
    ignoreFilter: true,
  },
]);

function onOpen() {
  if (!users.value?.length) {
    execute();
  }
}
</script>

<template>
  <UDrawer :handle="false" @update:open="onOpen">
    <UButton
      label="Search users..."
      color="neutral"
      variant="subtle"
      icon="i-lucide-search"
    />

    <template #content>
      <UCommandPalette
        v-model:search-term="searchTerm"
        :loading="status === 'pending'"
        :groups="groups"
        placeholder="Search users..."
        class="h-80"
      />
    </template>
  </UDrawer>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
