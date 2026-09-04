# UDashboardGroup

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardGroup component
 */
interface DashboardGroupProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?: { base?: any; } | undefined;
  /**
   * The storage to use for the size.
   * @default 'cookie'
   */
  storage?: "cookie" | "local" | undefined;
  /**
   * Unique id used to auto-save size.
   * @default 'dashboard'
   */
  storageKey?: string | undefined;
  /**
   * Options to pass to the underlying storage (`useCookie` or `useStorage`).
   */
  storageOptions?: Record<string, any> | undefined;
  /**
   * Whether to persist the size in the storage.
   * @default true
   */
  persistent?: boolean | undefined;
  /**
   * The unit to use for size values.
   * @default '%'
   */
  unit?: "%" | "rem" | "px" | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DashboardGroup component
 */
interface DashboardGroupSlots {
  default(): any;
}
```

## Usage

The DashboardGroup component is the main layout that wraps the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) and [DashboardPanel](https://ui.nuxt.com/docs/components/dashboard-panel) components to create a responsive dashboard interface.

Use it in a layout or in your `app.vue`:

```vue [layouts/dashboard.vue]
<template>
  <UDashboardGroup>
    <UDashboardSidebar />

    <slot />
  </UDashboardGroup>
</template>
```
