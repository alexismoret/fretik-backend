# UTooltip

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Tooltip component
 */
interface TooltipProps {
  /**
   * The text content of the tooltip.
   */
  text?: string | undefined;
  /**
   * The keyboard keys to display in the tooltip.
   */
  kbds?: (string | undefined)[] | KbdProps[] | undefined;
  /**
   * The content of the tooltip.
   *
   * Inherits from the `tooltip.content` of the {@link AppProps } component when not provided.
   * @default { side: 'bottom', sideOffset: 8, collisionPadding: 8 }
   */
  content?:
    | (Omit<TooltipContentProps, "as" | "asChild"> &
        Partial<EmitsToProps<TooltipContentImplEmits>>)
    | undefined;
  /**
   * Display an arrow alongside the tooltip.
   * `{ rounded: true }`{lang="ts-type"}
   * @default false
   */
  arrow?: boolean | Omit<TooltipArrowProps, "as" | "asChild"> | undefined;
  /**
   * Render the tooltip in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * The reference (or anchor) element that is being referred to for positioning.
   *
   * If not provided will use the current component as anchor.
   */
  reference?: Element | VirtualElement | undefined;
  ui?:
    | {
        content?: SlotClass;
        arrow?: SlotClass;
        text?: SlotClass;
        kbds?: SlotClass;
        kbdsSize?: SlotClass;
      }
    | undefined;
  /**
   * The open state of the tooltip when it is initially rendered.
   * Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The controlled open state of the tooltip.
   */
  open?: boolean | undefined;
  /**
   * Override the duration given to the `Provider` to customise
   * the open delay for a specific tooltip.
   * @default 700
   */
  delayDuration?: number | undefined;
  /**
   * Prevents Tooltip.Content from remaining open when hovering.
   * Disabling this has accessibility consequences. Inherits
   * from Tooltip.Provider.
   */
  disableHoverableContent?: boolean | undefined;
  /**
   * When `true`, clicking on trigger will not close the content.
   * @default false
   */
  disableClosingTrigger?: boolean | undefined;
  /**
   * When `true`, disable tooltip
   * @default false
   */
  disabled?: boolean | undefined;
  /**
   * Prevent the tooltip from opening if the focus did not come from
   * the keyboard by matching against the `:focus-visible` selector.
   * This is useful if you want to avoid opening it when switching
   * browser tabs or closing a dialog.
   * @default false
   */
  ignoreNonKeyboardFocus?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Tooltip component
 */
interface TooltipSlots {
  default(): any;
  content(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Tooltip component
 */
interface TooltipEmits {
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the Tooltip.

```vue
<template>
  <UTooltip text="Open on GitHub">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

> \[!WARNING]
>
> Make sure to wrap your app with the [`App`](https://ui.nuxt.com/docs/components/app) component which uses the [`TooltipProvider`](https://reka-ui.com/docs/components/tooltip#provider){rel="&#x22;nofollow&#x22;"} component from Reka UI.

> \[!TIP]
> See: /docs/components/app#props
>
> You can check the `App` component `tooltip` prop to see how to configure the Tooltip globally.

### Text

Use the `text` prop to set the content of the Tooltip.

```vue
<template>
  <UTooltip text="Open on GitHub">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

### Kbds

Use the `kbds` prop to render [Kbd](https://ui.nuxt.com/docs/components/kbd) components in the Tooltip.

```vue
<template>
  <UTooltip text="Open on GitHub" :kbds="['meta', 'G']">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

> \[!TIP]
>
> You can use special keys like `meta` that displays as `⌘` on macOS and `Ctrl` on other platforms.

### Delay

Use the `delay-duration` prop to change the delay before the Tooltip appears. For example, you can make it appear instantly by setting it to `0`.

```vue
<template>
  <UTooltip :delay-duration="0" text="Open on GitHub">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

> \[!TIP]
>
> This can be configured globally through the `tooltip.delayDuration` option in the [`App`](https://ui.nuxt.com/docs/components/app) component.

### Content

Use the `content` prop to control how the Tooltip content is rendered, like its `align` or `side` for example.

> \[!TIP]
>
> This can be configured globally through the `tooltip.content` option in the [`App`](https://ui.nuxt.com/docs/components/app) component.

```vue
<template>
  <UTooltip
    :content="{
      align: 'center',
      side: 'bottom',
      sideOffset: 8,
    }"
    text="Open on GitHub"
  >
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

### Arrow

Use the `arrow` prop to display an arrow on the Tooltip.

```vue
<template>
  <UTooltip arrow text="Open on GitHub">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

### Disabled

Use the `disabled` prop to disable the Tooltip.

```vue
<template>
  <UTooltip disabled text="Open on GitHub">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

## Examples

### Control open state

You can control the open state by using the `default-open` prop or the `v-model:open` directive.

```vue [TooltipOpenExample.vue]
<script setup lang="ts">
const open = ref(false);

defineShortcuts({
  o: () => (open.value = !open.value),
});
</script>

<template>
  <UTooltip v-model:open="open" text="Open on GitHub">
    <UButton label="Open" color="neutral" variant="subtle" />
  </UTooltip>
</template>
```

> \[!NOTE]
>
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the Tooltip by pressing :kbd{value="O"}.

### With following cursor

You can make the Tooltip follow the cursor when hovering over an element using the [`reference`](https://reka-ui.com/docs/components/tooltip#trigger){rel="&#x22;nofollow&#x22;"} prop:

```vue [TooltipCursorExample.vue]
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
  <UTooltip
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
      {{ anchor.x.toFixed(0) }} - {{ anchor.y.toFixed(0) }}
    </template>
  </UTooltip>
</template>
```
