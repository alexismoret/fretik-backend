# UDashboardSidebarToggle

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardSidebarToggle component
 */
interface DashboardSidebarToggleProps {
  /**
   * @default 'neutral'
   */
  color?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  /**
   * @default 'ghost'
   */
  variant?: "ghost" | "solid" | "outline" | "soft" | "subtle" | "link" | undefined;
  /**
   * The side of the sidebar to toggle.
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

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
> 
> This component also supports all native `<button>` HTML attributes.

## Composition

Also written in the docs and absent from the interface above — one per column or item: `#toggle`, `#header`.

## Usage

The DashboardSidebarToggle component is used by the [DashboardNavbar](https://ui.nuxt.com/docs/components/dashboard-navbar) and [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) components.

It is automatically displayed on mobile to toggle the sidebar, **you don't have to add it manually**.

```vue
<template>
  <UDashboardSidebarToggle />
</template>
```

It extends the [Button](https://ui.nuxt.com/docs/components/button) component, so you can pass any property such as `color`, `variant`, `size`, etc.

```vue
<template>
  <UDashboardSidebarToggle variant="subtle" />
</template>
```

> [!NOTE]
> 
> The button defaults to `color="neutral"` and `variant="ghost"`.

## Examples

### Within `toggle` slot

Even though this component is automatically displayed on mobile, you can use the `toggle` slot of the [DashboardNavbar](https://ui.nuxt.com/docs/components/dashboard-navbar) and [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) components to customize the button.

```vue [layouts/dashboard.vue]
<template>
  <UDashboardGroup>
    <UDashboardSidebar>
      <template #toggle>
        <UDashboardSidebarToggle variant="subtle" />
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
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Home">
        <template #toggle>
          <UDashboardSidebarToggle variant="subtle" />
        </template>
      </UDashboardNavbar>
    </template>
  </UDashboardPanel>
</template>
```

> [!TIP]
> 
> When using the `toggle-side` prop of the `DashboardSidebar` and `DashboardNavbar` components, the button will be displayed on the specified side.
