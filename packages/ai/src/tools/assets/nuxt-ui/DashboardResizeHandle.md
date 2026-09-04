# UDashboardResizeHandle

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardResizeHandle component
 */
interface DashboardResizeHandleProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?: { base?: any; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DashboardResizeHandle component
 */
interface DashboardResizeHandleSlots {
  default(): any;
}
```

## Composition

Also written in the docs and absent from the interface above — one per column or item: `#resize-handle`.

## Usage

The DashboardResizeHandle component is used by the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) and [DashboardPanel](https://ui.nuxt.com/docs/components/dashboard-panel) components.

It is automatically displayed when the `resizable` prop is set, **you don't have to add it manually**.

## Examples

### Within `resize-handle` slot

Even though this component is automatically displayed when the `resizable` prop is set, you can use the `resize-handle` slot of the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) and [DashboardPanel](https://ui.nuxt.com/docs/components/dashboard-panel) components to customize the handle.

```vue [layouts/dashboard.vue]
<template>
  <UDashboardGroup>
    <UDashboardSidebar resizable>
      <template #resize-handle="{ onMouseDown, onTouchStart, onDoubleClick }">
        <UDashboardResizeHandle
          class="after:absolute after:inset-y-0 after:right-0 after:w-px hover:after:bg-(--ui-border-accented) after:transition"
          @mousedown="onMouseDown"
          @touchstart="onTouchStart"
          @dblclick="onDoubleClick"
        />
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
```

```vue [pages/index.vue]
<script setup lang="ts">
definePageMeta({
  layout: 'dashboard'
})
</script>

<template>
  <UDashboardPanel resizable>
    <template #resize-handle="{ onMouseDown, onTouchStart, onDoubleClick }">
      <UDashboardResizeHandle
        class="after:absolute after:inset-y-0 after:right-0 after:w-px hover:after:bg-(--ui-border-accented) after:transition"
        @mousedown="onMouseDown"
        @touchstart="onTouchStart"
        @dblclick="onDoubleClick"
      />
    </template>
  </UDashboardPanel>
</template>
```

> [!NOTE]
> 
> In this example, we add an `after` pseudo-element to display a vertical line on hover.
