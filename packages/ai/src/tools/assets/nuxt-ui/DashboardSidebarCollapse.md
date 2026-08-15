# UDashboardSidebarCollapse

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardSidebarCollapse component
 */
interface DashboardSidebarCollapseProps {
  /**
   * @default 'neutral'
   */
  color?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  /**
   * @default 'ghost'
   */
  variant?: "ghost" | "solid" | "outline" | "soft" | "subtle" | "link" | undefined;
  /**
   * The side of the sidebar to collapse.
   * @default 'left'
   */
  side?: "left" | "right" | undefined;
  ui?: { base?: any; } | undefined;
  /**
   * Class to apply when the link is exact active
   */
  exactActiveClass?: string | undefined;
  /**
   * Pass the returned promise of `router.push()` to `document.startViewTransition()` if supported.
   */
  viewTransition?: boolean | undefined;
  autofocus?: false | true | "true" | "false" | undefined;
  disabled?: boolean | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  name?: string | undefined;
  /**
   * The type of the button when not a link.
   * @default 'button'
   */
  type?: "reset" | "submit" | "button" | undefined;
  onClick?: (event: MouseEvent): void | ((event: MouseEvent) => void)[] | undefined;
  /**
   * The element or component this component should render as when not a link.
   * @default 'button'
   */
  as?: any;
  label?: string | undefined;
  activeColor?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  activeVariant?: "ghost" | "solid" | "outline" | "soft" | "subtle" | "link" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * Render the button with equal padding on all sides.
   */
  square?: boolean | undefined;
  /**
   * Render the button full width.
   */
  block?: boolean | undefined;
  /**
   * Set loading state automatically based on the `@click` promise state
   */
  loadingAuto?: boolean | undefined;
  /**
   * Display an icon based on the `leading` and `trailing` props.
   */
  icon?: any;
  /**
   * Display an avatar on the left side.
   */
  avatar?: AvatarProps | undefined;
  /**
   * When `true`, the icon will be displayed on the left side.
   */
  leading?: boolean | undefined;
  /**
   * Display an icon on the left side.
   */
  leadingIcon?: any;
  /**
   * When `true`, the icon will be displayed on the right side.
   */
  trailing?: boolean | undefined;
  /**
   * Display an icon on the right side.
   */
  trailingIcon?: any;
  /**
   * When `true`, the loading icon will be displayed.
   */
  loading?: boolean | undefined;
  /**
   * The icon when the `loading` prop is `true`.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
}
```

> \[!NOTE]
> See: https\://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
>
> This component also supports all native `<button>` HTML attributes.

## Usage

The DashboardSidebarCollapse component is used to collapse/expand the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) component **when its `collapsible` prop is set**.

```vue
<template>
  <UDashboardSidebarCollapse />
</template>
```

It extends the [Button](https://ui.nuxt.com/docs/components/button) component, so you can pass any property such as `color`, `variant`, `size`, etc.

```vue
<template>
  <UDashboardSidebarCollapse variant="subtle" />
</template>
```

> \[!NOTE]
>
> The button defaults to `color="neutral"` and `variant="ghost"`.

## Examples

### Within `header` slot

You can put this component in the `header` slot of the [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) component and use the `collapsed` prop to hide the left part of the header for example:

```vue [layouts/dashboard.vue] {4-8}
<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible>
      <template #header="{ collapsed }">
        <Logo v-if="!collapsed" />

        <UDashboardSidebarCollapse variant="subtle" />
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
```

### Within `leading` slot

You can put this component in the `leading` slot of the [DashboardNavbar](https://ui.nuxt.com/docs/components/dashboard-navbar) component to display it before the title for example:

```vue [pages/index.vue] {11-13}
<script setup lang="ts">
definePageMeta({
  layout: "dashboard",
});
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Home">
        <template #leading>
          <UDashboardSidebarCollapse variant="subtle" />
        </template>
      </UDashboardNavbar>
    </template>
  </UDashboardPanel>
</template>
```
