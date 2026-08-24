# UDashboardPanel

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardPanel component
 */
interface DashboardPanelProps {
  ui?: { root?: SlotClass; body?: SlotClass; handle?: SlotClass } | undefined;
  /**
   * The id of the panel.
   * @default useId()
   */
  id?: string | undefined;
  /**
   * The minimum size of the panel.
   * @default 15
   */
  minSize?: number | undefined;
  /**
   * The maximum size of the panel.
   * @default 100
   */
  maxSize?: number | undefined;
  /**
   * The default size of the panel.
   * @default 0
   */
  defaultSize?: number | undefined;
  /**
   * Whether to allow the user to resize the panel.
   * @default false
   */
  resizable?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DashboardPanel component
 */
interface DashboardPanelSlots {
  default(): any;
  header(): any;
  body(): any;
  footer(): any;
  resize-handle(): any;
}
```

## Usage

The DashboardPanel component is used to display a panel. Its state (size, collapsed, etc.) will be saved based on the `storage` and `storage-key` props you provide to the [DashboardGroup](https://ui.nuxt.com/docs/components/dashboard-group#props) component.

Use it inside the default slot of the [DashboardGroup](https://ui.nuxt.com/docs/components/dashboard-group) component, you can put multiple panels next to each other:

```vue [pages/index.vue] {8,10}
<script setup lang="ts">
definePageMeta({
  layout: "dashboard",
});
</script>

<template>
  <UDashboardPanel id="inbox-1" resizable />

  <UDashboardPanel id="inbox-2" class="hidden lg:flex" />
</template>
```

> \[!CAUTION]
>
> It is recommended to set an `id` when using multiple panels in different pages to avoid conflicts.

> \[!WARNING]
>
> This component does not have a single root element when using the `resizable` prop, so wrap it in a container (e.g. `<div class="flex flex-1">`) if you use page transitions or require a single root for layout.

Use the `header`, `body` and `footer` slots to customize the panel or the default slot if you don't want a scrollable body with padding.

```vue [DashboardPanelExample.vue]
<template>
  <UDashboardPanel resizable>
    <template #header>
      <UDashboardNavbar title="Inbox">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <Placeholder class="h-full" />
    </template>
  </UDashboardPanel>
</template>
```

> \[!NOTE]
>
> Most of the time, you will use the [`DashboardNavbar`](https://ui.nuxt.com/docs/components/dashboard-navbar) component in the `header` slot.

### Resizable

Use the `resizable` prop to make the panel resizable.

```vue
<template>
  <UDashboardPanel resizable>
    <template #body>
      <Placeholder class="h-96" /> </template
  ></UDashboardPanel>
</template>
```

### Size

Use the `min-size`, `max-size` and `default-size` props to customize the size of the panel.

```vue
<template>
  <UDashboardPanel resizable :min-size="22" :default-size="35" :max-size="40">
    <template #body>
      <Placeholder class="h-96" /> </template
  ></UDashboardPanel>
</template>
```

> \[!TIP]
> See: /docs/components/dashboard-group#props
>
> Sizes are calculated as percentages by default. You can change this using the `unit` prop on the `DashboardGroup` component.
