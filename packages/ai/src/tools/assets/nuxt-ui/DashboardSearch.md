# UDashboardSearch

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DashboardSearch component
 */
interface DashboardSearchProps {
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "xs" | "lg" | "xl" | undefined;
  /**
   * Display a close button in the input (useful when inside a Modal for example).
   * `{ size: 'md', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default true
   */
  close?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * Configure the input or hide it with `false`.
   * `{ fixed: true }`{lang="ts-type"}
   * @default true
   */
  input?:
    | boolean
    | Omit<
        InputProps<AcceptableValue, ModelModifiers>,
        "modelValue" | "defaultValue"
      >
    | undefined;
  /**
   * Keyboard shortcut to open the search (used by [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts))
   * @default 'meta_k'
   */
  shortcut?: string | undefined;
  /**
   * Options for [useFuse](https://vueuse.org/integrations/useFuse) passed to the [CommandPalette](https://ui.nuxt.com/docs/components/command-palette).
   * @default {
fuseOptions: {
ignoreLocation: true,
useTokenSearch: true,
threshold: 0.1,
keys: ['label', 'description', 'suffix']
},
resultLimit: 12,
matchAllWhenSearchEmpty: true
}
   */
  fuse?: UseFuseOptions<CommandPaletteItem> | undefined;
  /**
   * Delay (in milliseconds) before the search term is passed to Fuse (debounced).
   * Useful for large datasets where running fuzzy search on every keystroke is the bottleneck — the input stays responsive while Fuse only re-runs after typing settles.
   * Set to `0` to disable.
   * @default 100
   */
  searchDelay?: number | undefined;
  /**
   * When `true`, the theme command will be added to the groups.
   * @default true
   */
  colorMode?: boolean | undefined;
  ui?:
    | ({ modal?: SlotClass; input?: SlotClass } & {
        root?: SlotClass;
        input?: SlotClass;
        close?: SlotClass;
        back?: SlotClass;
        content?: SlotClass;
        footer?: SlotClass;
        viewport?: SlotClass;
        group?: SlotClass;
        empty?: SlotClass;
        label?: SlotClass;
        item?: SlotClass;
        itemLeadingIcon?: SlotClass;
        itemLeadingAvatar?: SlotClass;
        itemLeadingAvatarSize?: SlotClass;
        itemLeadingChip?: SlotClass;
        itemLeadingChipSize?: SlotClass;
        itemTrailing?: SlotClass;
        itemTrailingIcon?: SlotClass;
        itemTrailingHighlightedIcon?: SlotClass;
        itemTrailingKbds?: SlotClass;
        itemTrailingKbdsSize?: SlotClass;
        itemWrapper?: SlotClass;
        itemLabel?: SlotClass;
        itemLabelBase?: SlotClass;
        itemLabelPrefix?: SlotClass;
        itemLabelSuffix?: SlotClass;
        itemDescription?: SlotClass;
      })
    | undefined;
  title?: string | undefined;
  /**
   * Animate the modal when opening or closing.
   * @default true
   */
  transition?: boolean | undefined;
  description?: string | undefined;
  /**
   * Render an overlay behind the modal.
   * @default true
   */
  overlay?: boolean | undefined;
  /**
   * The content of the modal.
   */
  content?:
    | (Omit<DialogContentProps, "as" | "asChild" | "forceMount"> &
        Partial<EmitsToProps<DialogContentImplEmits>>)
    | undefined;
  /**
   * When `false`, the modal will not close when clicking outside or pressing escape.
   * @default true
   */
  dismissible?: boolean | undefined;
  /**
   * When `true`, the modal will take up the full screen.
   * @default false
   */
  fullscreen?: boolean | undefined;
  /**
   * The modality of the dialog When set to `true`, <br>
   * interaction with outside elements will be disabled and only dialog content will be visible to screen readers.
   */
  modal?: boolean | undefined;
  /**
   * Render the modal in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * When set to `false`, the dialog content will not be unmounted when closed, but instead hidden with CSS. <br>
   * Useful for SEO or when you want to improve performance by not remounting the component on every open.
   * @default true
   */
  unmountOnHide?: boolean | undefined;
  /**
   * The icon displayed in the input. Set to `false` to hide the icon.
   * @default appConfig.ui.icons.search
   */
  icon?: any;
  /**
   * Automatically focus the input when component is mounted.
   * @default true
   */
  autofocus?: boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with listbox
   */
  disabled?: boolean | undefined;
  /**
   * The icon displayed on the right side of the input.
   * @default appConfig.ui.icons.search
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
  /**
   * The icon displayed when an item is selected.
   * @default appConfig.ui.icons.check
   */
  selectedIcon?: any;
  /**
   * The icon displayed when an item has children.
   * @default appConfig.ui.icons.chevronRight
   */
  childrenIcon?: any;
  /**
   * The placeholder text for the input.
   * @default t('commandPalette.placeholder')
   */
  placeholder?: string | undefined;
  /**
   * The icon displayed in the close button.
   * @default appConfig.ui.icons.close
   */
  closeIcon?: any;
  /**
   * Display a button to navigate back in history.
   * `{ size: 'md', color: 'neutral', variant: 'link' }`{lang="ts-type"}
   * @default true
   */
  back?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the back button.
   * @default appConfig.ui.icons.arrowLeft
   */
  backIcon?: any;
  /**
   * When `true`, hover over item will trigger highlight
   */
  highlightOnHover?: boolean | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?: string | undefined;
  /**
   * The key used to get the description from the item.
   * @default 'description'
   */
  descriptionKey?: string | undefined;
  /**
   * Whether to preserve the order of groups as defined in the `groups` prop when filtering.
   * When `false`, groups will appear based on item matches.
   * @default false
   */
  preserveGroupOrder?: boolean | undefined;
  /**
   * Enable virtualization for large lists.
   * Note: when enabled, all groups are flattened into a single list due to a limitation of Reka UI (https://github.com/unovue/reka-ui/issues/1885).
   * @default false
   */
  virtualize?:
    | boolean
    | {
        overscan?: number | undefined;
        estimateSize?: number | ((index: number) => number) | undefined;
      }
    | undefined;
  groups?: CommandPaletteGroup<CommandPaletteItem>[] | undefined;
  /**
   * @default false
   */
  open?: boolean | undefined;
  /**
   * @default ''
   */
  searchTerm?: string | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DashboardSearch component
 */
interface DashboardSearchSlots {
  empty(): any;
  footer(): any;
  back(): any;
  close(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-description(): any;
  item-trailing(): any;
  group-label(): any;
  content(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the DashboardSearch component
 */
interface DashboardSearchEmits {
  update:open: (payload: [value: boolean]) => void;
  update:searchTerm: (payload: [value: string]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name                                                                                                                                    | Type                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `commandPaletteRef`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<InstanceType<typeof UCommandPalette> | null>`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |

## Usage

The DashboardSearch component extends the [CommandPalette](https://ui.nuxt.com/docs/components/command-palette) component, so you can pass any property such as `icon`, `placeholder`, etc.

Use it inside the default slot of the [DashboardGroup](https://ui.nuxt.com/docs/components/dashboard-group) component:

```vue [layouts/dashboard.vue] {3}
<template>
  <UDashboardGroup>
    <UDashboardSidebar>
      <UDashboardSearchButton />
    </UDashboardSidebar>

    <UDashboardSearch />

    <slot />
  </UDashboardGroup>
</template>
```

> \[!TIP]
>
> You can open the CommandPalette by pressing :kbd{value="meta"} :kbd{.ms-px value="K"}, by using the [DashboardSearchButton](https://ui.nuxt.com/docs/components/dashboard-search-button) component or by using a `v-model:open`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts"} directive.

### Shortcut

Use the `shortcut` prop to change the shortcut used in [defineShortcuts](https://ui.nuxt.com/docs/composables/define-shortcuts) to open the ContentSearch component. Defaults to `meta_k` ( :kbd{value="meta"} :kbd{value="K"} ).

```vue [app.vue] {4}
<template>
  <UDashboardSearch
    v-model:search-term="searchTerm"
    shortcut="meta_k"
    :groups="groups"
    :fuse="{ resultLimit: 42 }"
  />
</template>
```

### Color Mode

By default, a group of commands will be added to the command palette so you can switch between light and dark mode. This will only take effect if the `colorMode` is not forced in a specific page which can be achieved through `definePageMeta`:

```vue [pages/index.vue]
<script setup lang="ts">
definePageMeta({
  colorMode: "dark",
});
</script>
```

You can disable this behavior by setting the `color-mode` prop to `false`:

```vue [app.vue] {4}
<template>
  <UDashboardSearch
    v-model:search-term="searchTerm"
    :color-mode="false"
    :groups="groups"
    :fuse="{ resultLimit: 42 }"
  />
</template>
```
