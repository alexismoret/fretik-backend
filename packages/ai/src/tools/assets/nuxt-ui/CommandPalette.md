# UCommandPalette

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the CommandPalette component
 */
interface CommandPaletteProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "xs" | "lg" | "xl" | undefined;
  /**
   * The icon displayed in the input. Set to `false` to hide the icon.
   * @default appConfig.ui.icons.search
   */
  icon?: any;
  /**
   * The icon displayed on the right side of the input.
   * @default appConfig.ui.icons.search
   */
  trailingIcon?: any;
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
   * Automatically focus the input when component is mounted.
   * @default true
   */
  autofocus?: boolean | undefined;
  /**
   * Display a close button in the input (useful when inside a Modal for example).
   * `{ size: 'md', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default false
   */
  close?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
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
   * Configure the input or hide it with `false`.
   * @default true
   */
  input?: boolean | Omit<InputProps<AcceptableValue, ModelModifiers>, "modelValue" | "defaultValue"> | undefined;
  groups?: G[] | undefined;
  /**
   * Options for [useFuse](https://vueuse.org/integrations/useFuse).
   * @default {
fuseOptions: {
ignoreLocation: true,
threshold: 0.1,
keys: ['label', 'description', 'suffix']
},
resultLimit: 12,
matchAllWhenSearchEmpty: true
}
   */
  fuse?: UseFuseOptions<T> | undefined;
  /**
   * Enable virtualization for large lists.
   * Note: when enabled, all groups are flattened into a single list due to a limitation of Reka UI (https://github.com/unovue/reka-ui/issues/1885).
   * @default false
   */
  virtualize?: boolean | { overscan?: number | undefined; estimateSize?: number | ((index: number) => number) | undefined; } | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the value instead of the object itself.
   * @default undefined
   */
  valueKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  /**
   * The key used to get the description from the item.
   * @default 'description'
   */
  descriptionKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  /**
   * Whether to preserve the order of groups as defined in the `groups` prop when filtering.
   * When `false`, groups will appear based on item matches.
   * @default false
   */
  preserveGroupOrder?: boolean | undefined;
  /**
   * Delay (in milliseconds) before the search term is passed to Fuse (debounced).
   * Useful when indexing large datasets where fuzzy search becomes the bottleneck — the input stays responsive while Fuse and the result pipeline only re-run after typing settles.
   * Set to `0` (the default) to disable.
   * @default 0
   */
  searchDelay?: number | undefined;
  ui?: { root?: SlotClass; input?: SlotClass; close?: SlotClass; back?: SlotClass; content?: SlotClass; footer?: SlotClass; viewport?: SlotClass; group?: SlotClass; empty?: SlotClass; label?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemLeadingChip?: SlotClass; itemLeadingChipSize?: SlotClass; itemTrailing?: SlotClass; itemTrailingIcon?: SlotClass; itemTrailingHighlightedIcon?: SlotClass; itemTrailingKbds?: SlotClass; itemTrailingKbdsSize?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemLabelBase?: SlotClass; itemLabelPrefix?: SlotClass; itemLabelSuffix?: SlotClass; itemDescription?: SlotClass; } | undefined;
  /**
   * Whether multiple options can be selected or not.
   */
  multiple?: boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with listbox
   */
  disabled?: boolean | undefined;
  /**
   * The controlled value of the listbox. Can be binded with `v-model`.
   */
  modelValue?: null | string | number | bigint | Record<string, any> | AcceptableValue[] | undefined;
  /**
   * The value of the listbox when initially rendered. Use when you do not need to control the state of the Listbox
   */
  defaultValue?: null | string | number | bigint | Record<string, any> | AcceptableValue[] | undefined;
  /**
   * When `true`, hover over item will trigger highlight
   * @default true
   */
  highlightOnHover?: boolean | undefined;
  /**
   * How multiple selection should behave in the collection.
   * @default 'toggle'
   */
  selectionBehavior?: "replace" | "toggle" | undefined;
  /**
   * Use this to compare objects by a particular field, or pass your own comparison function for complete control over how objects are compared.
   */
  by?: string | (a: AcceptableValue, b: AcceptableValue): boolean | undefined;
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
   * @default ''
   */
  searchTerm?: string | undefined;
}
```

### Slots

```ts
/**
 * Slots for the CommandPalette component
 */
interface CommandPaletteSlots {
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
}
```

### Emits

```ts
/**
 * Emitted events for the CommandPalette component
 */
interface CommandPaletteEmits {
  update:modelValue: (payload: [value: T]) => void;
  highlight: (payload: [payload: { ref: HTMLElement; value: T; } | undefined]) => void;
  entryFocus: (payload: [event: CustomEvent<any>]) => void;
  leave: (payload: [event: Event]) => void;
  update:open: (payload: [value: boolean]) => void;
  update:searchTerm: (payload: [value: string]) => void;
}
```

## Usage

Use the `v-model` directive to control the value of the CommandPalette or the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
import type { CommandPaletteGroup } from "@nuxt/ui";

const groups = ref<CommandPaletteGroup[]>([
  {
    id: "users",
    label: "Users",
    items: [
      {
        label: "Benjamin Canac",
        suffix: "benjamincanac",
        avatar: {
          src: "https://github.com/benjamincanac.png",
          loading: "lazy",
        },
      },
      {
        label: "Romain Hamel",
        suffix: "romhml",
        avatar: {
          src: "https://github.com/romhml.png",
          loading: "lazy",
        },
      },
      {
        label: "Sébastien Chopin",
        suffix: "atinux",
        avatar: {
          src: "https://github.com/atinux.png",
          loading: "lazy",
        },
      },
      {
        label: "Hugo Richard",
        suffix: "HugoRCD",
        avatar: {
          src: "https://github.com/HugoRCD.png",
          loading: "lazy",
        },
      },
      {
        label: "Sandro Circi",
        suffix: "sandros94",
        avatar: {
          src: "https://github.com/sandros94.png",
          loading: "lazy",
        },
      },
      {
        label: "Daniel Roe",
        suffix: "danielroe",
        avatar: {
          src: "https://github.com/danielroe.png",
          loading: "lazy",
        },
      },
      {
        label: "Jakub Michálek",
        suffix: "J-Michalek",
        avatar: {
          src: "https://github.com/J-Michalek.png",
          loading: "lazy",
        },
      },
      {
        label: "Eugen Istoc",
        suffix: "genu",
        avatar: {
          src: "https://github.com/genu.png",
          loading: "lazy",
        },
      },
    ],
  },
]);
const value = ref({});
</script>

<template>
  <UCommandPalette v-model="value" :groups="groups" class="flex-1 h-80" />
</template>
```

> \[!TIP]
> See: #control-selected-items
>
> You can also use the `@update:model-value` event to listen to the selected item(s).

### Groups

The CommandPalette component filters groups and ranks matching commands by relevance as users type. It provides dynamic, instant search results for efficient command discovery. Use the `groups` prop as an array of objects with the following properties:

- `id: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `items?: CommandPaletteItem[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`ignoreFilter?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-ignore-filter)
- [`postFilter?: (searchTerm: string, items: T[]) => T[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-post-filtered-items)
- `highlightedIcon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

> \[!CAUTION]
>
> You must provide an `id` for each group otherwise the group will be ignored.

Each group contains an `items` array of objects that define the commands. Each item can have the following properties:

- `prefix?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `suffix?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `avatar?: AvatarProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `chip?: ChipProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `kbds?: string[] | KbdProps[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `active?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `loading?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-custom-slot)
- `placeholder?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `children?: CommandPaletteItem[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `onSelect?: (e: Event) => void`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingAvatarSize?: ClassNameValue, itemLeadingAvatar?: ClassNameValue, itemLeadingChipSize?: ClassNameValue, itemLeadingChip?: ClassNameValue, itemLabel?: ClassNameValue, itemLabelPrefix?: ClassNameValue, itemLabelBase?: ClassNameValue, itemLabelSuffix?: ClassNameValue, itemTrailing?: ClassNameValue, itemTrailingKbds?: ClassNameValue, itemTrailingKbdsSize?: ClassNameValue, itemTrailingHighlightedIcon?: ClassNameValue, itemTrailingIcon?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { CommandPaletteGroup } from "@nuxt/ui";

const groups = ref<CommandPaletteGroup[]>([
  {
    id: "users",
    label: "Users",
    items: [
      {
        label: "Benjamin Canac",
        suffix: "benjamincanac",
        avatar: {
          src: "https://github.com/benjamincanac.png",
          loading: "lazy",
        },
      },
      {
        label: "Romain Hamel",
        suffix: "romhml",
        avatar: {
          src: "https://github.com/romhml.png",
          loading: "lazy",
        },
      },
      {
        label: "Sébastien Chopin",
        suffix: "atinux",
        avatar: {
          src: "https://github.com/atinux.png",
          loading: "lazy",
        },
      },
      {
        label: "Hugo Richard",
        suffix: "HugoRCD",
        avatar: {
          src: "https://github.com/HugoRCD.png",
          loading: "lazy",
        },
      },
      {
        label: "Sandro Circi",
        suffix: "sandros94",
        avatar: {
          src: "https://github.com/sandros94.png",
          loading: "lazy",
        },
      },
      {
        label: "Daniel Roe",
        suffix: "danielroe",
        avatar: {
          src: "https://github.com/danielroe.png",
          loading: "lazy",
        },
      },
      {
        label: "Jakub Michálek",
        suffix: "J-Michalek",
        avatar: {
          src: "https://github.com/J-Michalek.png",
          loading: "lazy",
        },
      },
      {
        label: "Eugen Istoc",
        suffix: "genu",
        avatar: {
          src: "https://github.com/genu.png",
          loading: "lazy",
        },
      },
    ],
  },
]);
const value = ref({});
</script>

<template>
  <UCommandPalette v-model="value" :groups="groups" class="flex-1" />
</template>
```

> \[!TIP]
> See: #with-children-in-items
>
> Each item can take a `children` array of objects with the following properties to create submenus:

### Multiple

Use the `multiple` prop to allow multiple selections.

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control selected item(s)

You can control the selected item(s) by using the `default-value` prop or the `v-model` directive, by using the `onSelect` field on each item or by using the `@update:model-value` event.

```vue [CommandPaletteSelectExample.vue]
<script setup lang="ts">
const toast = useToast();

const groups = ref([
  {
    id: "users",
    label: "Users",
    items: [
      {
        label: "Benjamin Canac",
        suffix: "benjamincanac",
        to: "https://github.com/benjamincanac",
        target: "_blank",
        avatar: {
          src: "https://github.com/benjamincanac.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Romain Hamel",
        suffix: "romhml",
        to: "https://github.com/romhml",
        target: "_blank",
        avatar: {
          src: "https://github.com/romhml.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Sébastien Chopin",
        suffix: "atinux",
        to: "https://github.com/atinux",
        target: "_blank",
        avatar: {
          src: "https://github.com/atinux.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Hugo Richard",
        suffix: "HugoRCD",
        to: "https://github.com/HugoRCD",
        target: "_blank",
        avatar: {
          src: "https://github.com/HugoRCD.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Sandro Circi",
        suffix: "sandros94",
        to: "https://github.com/sandros94",
        target: "_blank",
        avatar: {
          src: "https://github.com/sandros94.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Daniel Roe",
        suffix: "danielroe",
        to: "https://github.com/danielroe",
        target: "_blank",
        avatar: {
          src: "https://github.com/danielroe.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Jakub Michálek",
        suffix: "J-Michalek",
        to: "https://github.com/J-Michalek",
        target: "_blank",
        avatar: {
          src: "https://github.com/J-Michalek.png",
          loading: "lazy" as const,
        },
      },
      {
        label: "Eugen Istoc",
        suffix: "genu",
        to: "https://github.com/genu",
        target: "_blank",
        avatar: {
          src: "https://github.com/genu.png",
          loading: "lazy" as const,
        },
      },
    ],
  },
  {
    id: "actions",
    items: [
      {
        label: "Add new file",
        suffix: "Create a new file in the current directory or workspace.",
        icon: "i-lucide-file-plus",
        kbds: ["meta", "N"],
        onSelect() {
          toast.add({ title: "Add new file" });
        },
      },
      {
        label: "Add new folder",
        suffix: "Create a new folder in the current directory or workspace.",
        icon: "i-lucide-folder-plus",
        kbds: ["meta", "F"],
        onSelect() {
          toast.add({ title: "Add new folder" });
        },
      },
      {
        label: "Add hashtag",
        suffix: "Add a hashtag to the current item.",
        icon: "i-lucide-hash",
        kbds: ["meta", "H"],
        onSelect() {
          toast.add({ title: "Add hashtag" });
        },
      },
      {
        label: "Add label",
        suffix: "Add a label to the current item.",
        icon: "i-lucide-tag",
        kbds: ["meta", "L"],
        onSelect() {
          toast.add({ title: "Add label" });
        },
      },
    ],
  },
]);

function onSelect(item: any) {
  console.log(item);
}
</script>

<template>
  <UCommandPalette
    :groups="groups"
    class="flex-1 h-80"
    @update:model-value="onSelect"
  />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
