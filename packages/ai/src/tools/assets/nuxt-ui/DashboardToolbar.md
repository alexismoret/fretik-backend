# UDashboardToolbar

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardToolbar component
 */
interface DashboardToolbarProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?: { root?: SlotClass; left?: SlotClass; right?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DashboardToolbar component
 */
interface DashboardToolbarSlots {
  default(): any;
  left(): any;
  right(): any;
}
```

## Composition

Parts placed by name: `#left`, `#right`.

Also written in the docs and absent from the interface above — one per column or item: `#header`.

## Usage

The DashboardToolbar component is used to display a toolbar under the [DashboardNavbar](https://ui.nuxt.com/docs/components/dashboard-navbar) component.

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

      <UDashboardToolbar />
    </template>
  </UDashboardPanel>
</template>
```

Use the `left`, `default` and `right` slots to customize the toolbar.

```vue [DashboardToolbarExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const items: NavigationMenuItem[][] = [[{
  label: 'General',
  icon: 'i-lucide-user',
  active: true
}, {
  label: 'Members',
  icon: 'i-lucide-users'
}, {
  label: 'Notifications',
  icon: 'i-lucide-bell'
}], [{
  label: 'Documentation',
  icon: 'i-lucide-book-open',
  to: 'https://ui.nuxt.com/docs',
  target: '_blank'
}, {
  label: 'Help & Feedback',
  icon: 'i-lucide-help-circle',
  to: 'https://github.com/nuxt/ui/issues',
  target: '_blank'
}]]
</script>

<template>
  <UDashboardToolbar>
    <UNavigationMenu :items="items" highlight class="flex-1" />
  </UDashboardToolbar>
</template>
```

> [!NOTE]
> 
> In this example, we use the [NavigationMenu](https://ui.nuxt.com/docs/components/navigation-menu) component to render some links.
