# UPopover

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Popover component
 */
interface PopoverProps {
  /**
   * The display mode of the popover.
   * @default 'click'
   */
  mode?: M | undefined;
  /**
   * The content of the popover.
   * @default { side: 'bottom', sideOffset: 8, collisionPadding: 8 }
   */
  content?:
    | (Omit<PopoverContentProps, "as" | "asChild" | "forceMount"> &
        Partial<EmitsToProps<PopoverContentImplEmits>>)
    | undefined;
  /**
   * Display an arrow alongside the popover.
   * `{ rounded: true }`{lang="ts-type"}
   * @default false
   */
  arrow?: boolean | Omit<PopoverArrowProps, "as" | "asChild"> | undefined;
  /**
   * Render the popover in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * The reference (or anchor) element that is being referred to for positioning.
   *
   * Accepts an element or a virtual element (anything with `getBoundingClientRect`),
   * and can be changed reactively to re-anchor the popover (e.g. for a guided tour).
   * If not provided will use the current component as anchor.
   */
  reference?: Element | VirtualElement | undefined;
  /**
   * When `false`, the popover will not close when clicking outside or pressing escape.
   * @default true
   */
  dismissible?: boolean | undefined;
  ui?: { content?: SlotClass; arrow?: SlotClass } | undefined;
  /**
   * The open state of the popover when it is initially rendered. Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The controlled open state of the popover.
   */
  open?: boolean | undefined;
  /**
   * The modality of the popover. When set to true, interaction with outside elements will be disabled and only popover content will be visible to screen readers.
   * @default false
   */
  modal?: boolean | undefined;
  /**
   * The duration from when the mouse enters the trigger until the hover card opens.
   * @default 0
   */
  openDelay?: number | undefined;
  /**
   * The duration from when the mouse leaves the trigger or content until the hover card closes.
   * @default 0
   */
  closeDelay?: number | undefined;
  /**
   * When `true`, tapping the trigger on touch devices toggles the hover card open/closed. By default touch interactions are ignored to match pointer hover semantics.
   */
  enableTouch?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Popover component
 */
interface PopoverSlots {
  default(): any;
  content(): any;
  anchor(): any;
}
```

> \[!NOTE]
>
> The `close` function is only available when `mode` is set to `click` because Reka UI exposes this for [`Popover`](https://reka-ui.com/docs/components/popover#close-using-slot-props){rel="&#x22;nofollow&#x22;"} but not for [`HoverCard`](https://reka-ui.com/docs/components/hover-card){rel="&#x22;nofollow&#x22;"}.

### Emits

```ts
/**
 * Emitted events for the Popover component
 */
interface PopoverEmits {
  close:prevent: (payload: []) => void;
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the Popover.

Then, use the `#content` slot to add the content displayed when the Popover is open.

```vue
<template>
  <UPopover>
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" /> </template
  ></UPopover>
</template>
```

### Mode

Use the `mode` prop to change the mode of the Popover. Defaults to `click`.

> \[!TIP]
>
> In `hover` mode, set the `enable-touch` prop to let users toggle the Popover by tapping the trigger on touch devices, or use the `click` mode for triggers meant to be tapped.

```vue
<template>
  <UPopover mode="hover" enable-touch>
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" /> </template
  ></UPopover>
</template>
```

> \[!NOTE]
>
> When using the `hover` mode, the Reka UI [`HoverCard`](https://reka-ui.com/docs/components/hover-card){rel="&#x22;nofollow&#x22;"} component is used instead of the [`Popover`](https://reka-ui.com/docs/components/popover){rel="&#x22;nofollow&#x22;"}.

### Delay

When using the `hover` mode, you can use the `open-delay` and `close-delay` props to control the delay before the Popover is opened or closed.

```vue
<template>
  <UPopover mode="hover" :open-delay="500" :close-delay="300">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" /> </template
  ></UPopover>
</template>
```

### Content

Use the `content` prop to control how the Popover content is rendered, like its `align` or `side` for example.

```vue
<template>
  <UPopover
    :content="{
      align: 'center',
      side: 'bottom',
      sideOffset: 8,
    }"
  >
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" /> </template
  ></UPopover>
</template>
```

### Arrow

Use the `arrow` prop to display an arrow on the Popover.

```vue
<template>
  <UPopover arrow>
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" /> </template
  ></UPopover>
</template>
```

### Modal

Use the `modal` prop to control whether the Popover blocks interaction with outside content. Defaults to `false`.

```vue
<template>
  <UPopover modal>
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" /> </template
  ></UPopover>
</template>
```

### Dismissible

Use the `dismissible` prop to control whether the Popover is dismissible when clicking outside of it or pressing escape. Defaults to `true`.

> \[!NOTE]
>
> A `close:prevent` event will be emitted when the user tries to close it.

```vue [PopoverDismissibleExample.vue]
<template>
  <UPopover :dismissible="false" :ui="{ content: 'p-4' }">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content="{ close }">
      <div class="flex items-center gap-4 mb-4">
        <h2 class="text-highlighted font-semibold">Popover non-dismissible</h2>

        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          @click="close"
        />
      </div>

      <Placeholder class="size-full min-h-48" />
    </template>
  </UPopover>
</template>
```

## Examples

### Control open state

You can control the open state by using the `default-open` prop or the `v-model:open` directive.

```vue [PopoverOpenExample.vue]
<script setup lang="ts">
const open = ref(false);

defineShortcuts({
  o: () => (open.value = !open.value),
});
</script>

<template>
  <UPopover v-model:open="open">
    <UButton label="Open" color="neutral" variant="subtle" />

    <template #content>
      <Placeholder class="size-48 m-4 inline-flex" />
    </template>
  </UPopover>
</template>
```

> \[!NOTE]
>
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the Popover by pressing :kbd{value="O"}.

### With command palette

You can use a [CommandPalette](https://ui.nuxt.com/docs/components/command-palette) component inside the Popover's content.

```vue [PopoverCommandPaletteExample.vue]
<script setup lang="ts">
import type { CommandPaletteItem } from "@nuxt/ui";

const items = ref([
  {
    label: "bug",
    value: "bug",
    chip: {
      color: "error",
    },
  },
  {
    label: "feature",
    value: "feature",
    chip: {
      color: "success",
    },
  },
  {
    label: "enhancement",
    value: "enhancement",
    chip: {
      color: "info",
    },
  },
] satisfies CommandPaletteItem[]);

const label = ref([]);
</script>

<template>
  <UPopover :content="{ side: 'right', align: 'start' }">
    <UButton
      icon="i-lucide-tag"
      label="Select labels"
      color="neutral"
      variant="subtle"
    />

    <template #content>
      <UCommandPalette
        v-model="label"
        multiple
        placeholder="Search labels..."
        :groups="[{ id: 'labels', items }]"
        :ui="{ input: '[&>input]:h-8 [&>input]:text-sm' }"
      />
    </template>
  </UPopover>
</template>
```

### With following cursor

You can make the Popover follow the cursor when hovering over an element using the [`reference`](https://reka-ui.com/docs/components/tooltip#trigger){rel="&#x22;nofollow&#x22;"} prop:

```vue [PopoverCursorExample.vue]
<script setup lang="ts">
const open = ref(false);
const anchor = ref({ x: 0, y: 0 });

const reference = computed(() => ({
  getBoundingClientRect: () =>
    ({
      width: 0,
      height: 0,
      left: anchor.value.x,
      right: anchor.value.x,
      top: anchor.value.y,
      bottom: anchor.value.y,
      ...anchor.value,
    }) as DOMRect,
}));
</script>

<template>
  <UPopover
    :open="open"
    :reference="reference"
    :content="{ side: 'top', sideOffset: 16, updatePositionStrategy: 'always' }"
  >
    <div
      class="flex items-center justify-center rounded-md border border-dashed border-accented text-sm aspect-video w-72"
      @pointerenter="open = true"
      @pointerleave="open = false"
      @pointermove="
        (ev: PointerEvent) => {
          anchor.x = ev.clientX;
          anchor.y = ev.clientY;
        }
      "
    >
      Hover me
    </div>

    <template #content>
      <div class="p-4">
        {{ anchor.x.toFixed(0) }} - {{ anchor.y.toFixed(0) }}
      </div>
    </template>
  </UPopover>
</template>
```

### With anchor slot

You can use the `#anchor` slot to position the Popover against a custom element.

> \[!WARNING]
>
> This slot only works when `mode` is `click`.

```vue [PopoverAnchorSlotExample.vue]
<script lang="ts" setup>
const open = ref(false);
</script>

<template>
  <UPopover
    v-model:open="open"
    :dismissible="false"
    :ui="{ content: 'w-(--reka-popper-anchor-width) p-4' }"
  >
    <template #anchor>
      <UInput
        placeholder="Focus to open"
        @focus="open = true"
        @blur="open = false"
      />
    </template>

    <template #content>
      <Placeholder class="w-full aspect-square" />
    </template>
  </UPopover>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
