# UDashboardNavbar

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardNavbar component
 */
interface DashboardNavbarProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The icon displayed next to the title.
   */
  icon?: any;
  title?: string | undefined;
  /**
   * Customize the toggle button to open the sidebar.
   * `{ color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default true
   */
  toggle?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The side to render the toggle button on.
   * @default 'left'
   */
  toggleSide?: "left" | "right" | undefined;
  ui?: { root?: SlotClass; left?: SlotClass; icon?: SlotClass; title?: SlotClass; center?: SlotClass; right?: SlotClass; toggle?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DashboardNavbar component
 */
interface DashboardNavbarSlots {
  title(): any;
  leading(): any;
  trailing(): any;
  left(): any;
  default(): any;
  right(): any;
  toggle(): any;
}
```

## Composition

Parts placed by name: `#left`, `#right`, `#toggle`.

Also written in the docs and absent from the interface above — one per column or item: `#header`.

## Usage

The DashboardNavbar component is a responsive navigation bar that integrates with the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) component. It includes a mobile toggle button to enable responsive navigation in dashboard layouts.

Use it inside the `header` slot of the [DashboardPanel](https://ui.nuxt.com/docs/components/dashboard-panel) component:

```vue [pages/index.vue]
<script setup lang="ts">
definePageMeta({
  layout: 'dashboard'
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar />
    </template>
  </UDashboardPanel>
</template>
```

Use the `left`, `default` and `right` slots to customize the navbar.

```vue [DashboardNavbarExample.vue]
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items: TabsItem[] = [{
  label: 'All',
  value: 'all'
}, {
  label: 'Unread',
  value: 'unread'
}]
</script>

<template>
  <UDashboardNavbar title="Inbox">
    <template #leading>
      <UDashboardSidebarCollapse />
    </template>

    <template #trailing>
      <UBadge label="4" variant="subtle" />
    </template>

    <template #right>
      <UTabs
        :items="items"
        default-value="all"
        size="sm"
        class="w-40"
        :content="false"
      />
    </template>
  </UDashboardNavbar>
</template>
```

> [!NOTE]
> 
> In this example, we use the [Tabs](https://ui.nuxt.com/docs/components/tabs) component in the right slot to display some tabs.

### Title

Use the `title` prop to set the title of the navbar.

```vue
<template>
  <UDashboardNavbar title="Dashboard" />
</template>
```

### Icon

Use the `icon` prop to set the icon of the navbar.

```vue
<template>
  <UDashboardNavbar title="Dashboard" icon="i-lucide-house" />
</template>
```

### Toggle

Use the `toggle` prop to customize the toggle button displayed on mobile that opens the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) component.

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button) component to customize it.

```vue [DashboardNavbarToggleExample.vue]
<template>
  <UDashboardNavbar
    title="Dashboard"
    :toggle="{
      color: 'primary',
      variant: 'subtle',
      class: 'rounded-full'
    }"
  />
</template>
```

### Toggle Side

Use the `toggle-side` prop to change the side of the toggle button. Defaults to `right`.

```vue [DashboardNavbarToggleSideExample.vue]
<template>
  <UDashboardNavbar
    title="Dashboard"
    toggle-side="right"
  />
</template>
```
