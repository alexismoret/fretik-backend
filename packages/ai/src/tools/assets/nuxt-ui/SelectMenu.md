# USelectMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the SelectMenu component
 */
interface SelectMenuProps {
  id?: string | undefined;
  /**
   * The placeholder text when the select is empty.
   */
  placeholder?: string | undefined;
  /**
   * Whether to display the search input or not.
   * Can be an object to pass additional props to the input.
   * `{ placeholder: 'Search...', variant: 'none' }`{lang="ts-type"}
   * Set `autofocus: false` to prevent the search input from being focused when the menu opens (e.g. to avoid opening the virtual keyboard on touch devices).
   * @default true
   */
  searchInput?: boolean | Omit<InputProps<AcceptableValue, ModelModifiers>, "modelValue" | "defaultValue"> | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "ghost" | "none" | undefined;
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "xs" | "lg" | "xl" | undefined;
  required?: boolean | undefined;
  /**
   * The icon displayed to open the menu.
   * @default appConfig.ui.icons.chevronDown
   */
  trailingIcon?: any;
  /**
   * The icon displayed when an item is selected.
   * @default appConfig.ui.icons.check
   */
  selectedIcon?: any;
  /**
   * Display a clear button to reset the model value.
   * Can be an object to pass additional props to the Button.
   * @default false
   */
  clear?: C & false | C & true | C & Partial<Omit<ButtonProps, LinkPropsKeys>> | undefined;
  /**
   * The icon displayed in the clear button.
   * @default appConfig.ui.icons.close
   */
  clearIcon?: any;
  /**
   * The content of the menu.
   * @default { side: 'bottom', sideOffset: 8, collisionPadding: 8, position: 'popper' }
   */
  content?: Omit<ComboboxContentProps, "asChild" | "as" | "forceMount"> & Partial<EmitsToProps<DismissableLayerEmits>> | undefined;
  /**
   * Display an arrow alongside the menu.
   * `{ rounded: true }`{lang="ts-type"}
   * @default false
   */
  arrow?: boolean | Omit<ComboboxArrowProps, "asChild" | "as"> | undefined;
  /**
   * Render the menu in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
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
  valueKey?: VK | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the label.
   * @default 'label'
   */
  labelKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the description.
   * @default 'description'
   */
  descriptionKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  items?: T | undefined;
  /**
   * The value of the SelectMenu when initially rendered. Use when you do not need to control the state of the SelectMenu.
   */
  defaultValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C> | undefined;
  /**
   * The controlled value of the SelectMenu. Can be binded-with with `v-model`.
   */
  modelValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C> | undefined;
  modelModifiers?: Mod | undefined;
  /**
   * Whether multiple options can be selected or not.
   */
  multiple?: M | undefined;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  /**
   * Determines if custom user input that does not exist in options can be added.
   * @default false
   */
  createItem?: boolean | "always" | { position?: "top" | "bottom" | undefined; when?: "always" | "empty" | undefined; } | undefined;
  /**
   * Fields to filter items by.
   * @default [labelKey]
   */
  filterFields?: string[] | undefined;
  /**
   * When `true`, disable the default filters, useful for custom filtering (useAsyncData, useFetch, etc.).
   * @default false
   */
  ignoreFilter?: boolean | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  ui?: { base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; value?: SlotClass; placeholder?: SlotClass; arrow?: SlotClass; content?: SlotClass; viewport?: SlotClass; group?: SlotClass; empty?: SlotClass; label?: SlotClass; separator?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemLeadingChip?: SlotClass; itemLeadingChipSize?: SlotClass; itemTrailing?: SlotClass; itemTrailingIcon?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; input?: SlotClass; focusScope?: SlotClass; trailingClear?: SlotClass; } | undefined;
  /**
   * When `true`, prevents the user from interacting with listbox
   */
  disabled?: boolean | undefined;
  /**
   * The controlled open state of the Combobox. Can be binded with `v-model:open`.
   */
  open?: boolean | undefined;
  /**
   * The open state of the combobox when it is initially rendered. <br> Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * Whether to reset the searchTerm when the Combobox input blurred
   * @default true
   */
  resetSearchTermOnBlur?: boolean | undefined;
  /**
   * Whether to reset the searchTerm when the Combobox value is selected
   * @default true
   */
  resetSearchTermOnSelect?: boolean | undefined;
  /**
   * When `true` the `modelValue` will be reset to `null` (or `[]` if `multiple`)
   * @default true
   */
  resetModelValueOnClear?: boolean | undefined;
  /**
   * When `true`, hover over item will trigger highlight
   */
  highlightOnHover?: boolean | undefined;
  /**
   * Use this to compare objects by a particular field, or pass your own comparison function for complete control over how objects are compared.
   */
  by?: string | (a: T, b: T): boolean | undefined;
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
   * When `true`, the loading icon will be displayed.
   */
  loading?: boolean | undefined;
  /**
   * The icon when the `loading` prop is `true`.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  /**
   * @default ''
   */
  searchTerm?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
> 
> This component also supports all native `<button>` HTML attributes.

### Slots

```ts
/**
 * Slots for the SelectMenu component
 */
interface SelectMenuSlots {
  leading(): any;
  default(): any;
  trailing(): any;
  empty(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-description(): any;
  item-trailing(): any;
  content-top(): any;
  content-bottom(): any;
  create-item-label(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the SelectMenu component
 */
interface SelectMenuEmits {
  update:open: (payload: [value: boolean]) => void;
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  focus: (payload: [event: FocusEvent]) => void;
  create: (payload: [item: string]) => void;
  clear: (payload: []) => void;
  highlight: (payload: [payload: { ref: HTMLElement; value: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C>; } | undefined]) => void;
  update:modelValue: (payload: [value: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C>]) => void;
  update:searchTerm: (payload: [value: string]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `triggerRef` | `Ref<HTMLButtonElement \| null>` |
| `viewportRef` | `Ref<HTMLDivElement \| null>` |

## Composition

Parts placed by name: `#empty`, `#item`, `#item-leading`, `#item-label`, `#item-description`, `#item-trailing`, `#content-top`, `#content-bottom`, `#create-item-label`.

## Usage

Use the `v-model` directive to control the value of the SelectMenu or the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
const items = ref([
  "Backlog",
  "Todo",
  "In Progress",
  "Done"
])
const value = ref("Backlog")
</script>

<template>
  <USelectMenu v-model="value" :items="items" />
</template>
```

> [!TIP]
> 
> Use this over a [`Select`](https://ui.nuxt.com/docs/components/select) to take advantage of Reka UI's [`Combobox`](https://reka-ui.com/docs/components/combobox) component that offers search capabilities and multiple selection.

> [!NOTE]
> 
> This component is similar to the [`InputMenu`](https://ui.nuxt.com/docs/components/input-menu) but it's using a Select instead of an Input with the search inside the menu.

### Items

Use the `items` prop as an array of strings, numbers or booleans:

```vue
<script setup lang="ts">
const items = ref([
  "Backlog",
  "Todo",
  "In Progress",
  "Done"
])
const value = ref("Backlog")
</script>

<template>
  <USelectMenu v-model="value" :items="items" class="w-48" />
</template>
```

You can also pass an array of objects with the following properties:

- `label?: string`
- [`type?: "label" | "separator" | "item"`](#with-items-type)
- [`icon?: string`](#with-icons-in-items)
- [`avatar?: AvatarProps`](#with-avatar-in-items)
- [`chip?: ChipProps`](#with-chip-in-items)
- `disabled?: boolean`
- `onSelect?: (e: Event) => void`
- `class?: any`
- `ui?: { label?: ClassNameValue, separator?: ClassNameValue, item?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingAvatarSize?: ClassNameValue, itemLeadingAvatar?: ClassNameValue, itemLeadingChipSize?: ClassNameValue, itemLeadingChip?: ClassNameValue, itemLabel?: ClassNameValue, itemTrailing?: ClassNameValue, itemTrailingIcon?: ClassNameValue }`

```vue
<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'

const items = ref<SelectMenuItem[]>([
  {
    label: "Backlog"
  },
  {
    label: "Todo"
  },
  {
    label: "In Progress"
  },
  {
    label: "Done"
  }
])
const value = ref({
  label: "Todo"
})
</script>

<template>
  <USelectMenu v-model="value" :items="items" class="w-48" />
</template>
```

> [!CAUTION]
> 
> Unlike the [`Select`](https://ui.nuxt.com/docs/components/select) component, the SelectMenu expects the whole object to be passed to the `v-model` directive or the `default-value` prop by default.

You can also pass an array of arrays to the `items` prop to display separated groups of items.

```vue
<script setup lang="ts">
const items = ref([
  [
    "Apple",
    "Banana",
    "Blueberry",
    "Grapes",
    "Pineapple"
  ],
  [
    "Aubergine",
    "Broccoli",
    "Carrot",
    "Courgette",
    "Leek"
  ]
])
const value = ref("Apple")
</script>

<template>
  <USelectMenu v-model="value" :items="items" class="w-48" />
</template>
```

### Value Key

You can choose to bind a single property of the object rather than the whole object by using the `value-key` prop. Defaults to `undefined`.

```vue
<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'

const items = ref<SelectMenuItem[]>([
  {
    label: "Backlog",
    id: "backlog"
  },
  {
    label: "Todo",
    id: "todo"
  },
  {
    label: "In Progress",
    id: "in_progress"
  },
  {
    label: "Done",
    id: "done"
  }
])
const value = ref("todo")
</script>

<template>
  <USelectMenu v-model="value" value-key="id" :items="items" class="w-48" />
</template>
```

> [!TIP]
> 
> Use the `by` prop to compare objects by a field instead of reference when the `model-value` is an object.

### Multiple

Use the `multiple` prop to allow multiple selections, the selected items will be separated by a comma in the trigger.

```vue
<script setup lang="ts">
const items = ref([
  "Backlog",
  "Todo",
  "In Progress",
  "Done"
])
const value = ref([
  "Backlog",
  "Todo"
])
</script>

<template>
  <USelectMenu v-model="value" multiple :items="items" class="w-48" />
</template>
```

> [!CAUTION]
> 
> Ensure to pass an array to the `default-value` prop or the `v-model` directive.

### Placeholder

Use the `placeholder` prop to set a placeholder text.

```vue
<script setup lang="ts">
const items = ref([
  "Backlog",
  "Todo",
  "In Progress",
  "Done"
])
</script>

<template>
  <USelectMenu placeholder="Select status" :items="items" class="w-48" />
</template>
```

### Search Input

Use the `search-input` prop to customize or hide the search input (with `false` value).

You can pass any property from the [Input](https://ui.nuxt.com/docs/components/input) component to customize it.

```vue
<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'

const items = ref<SelectMenuItem[]>([
  {
    label: "Backlog",
    icon: "i-lucide-circle-help"
  },
  {
    label: "Todo",
    icon: "i-lucide-circle-plus"
  },
  {
    label: "In Progress",
    icon: "i-lucide-circle-arrow-up"
  },
  {
    label: "Done",
    icon: "i-lucide-circle-check"
  }
])
const value = ref({
  label: "Backlog",
  icon: "i-lucide-circle-help"
})
</script>

<template>
  <USelectMenu v-model="value" :search-input="{
  placeholder: 'Filter...',
  icon: 'i-lucide-search'
}" :items="items" class="w-48" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With items type

You can use the `type` property with `separator` to display a separator between items or `label` to display a label.

```vue
<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'

const items = ref<SelectMenuItem[]>([
  [
    {
      type: "label",
      label: "Fruits"
    },
    "Apple",
    "Banana",
    "Blueberry",
    "Grapes",
    "Pineapple"
  ],
  [
    {
      type: "label",
      label: "Vegetables"
    },
    "Aubergine",
    "Broccoli",
    "Carrot",
    "Courgette",
    "Leek"
  ]
])
const value = ref("Apple")
</script>

<template>
  <USelectMenu v-model="value" :items="items" class="w-48" />
</template>
```

> [!NOTE]
> 
> When using `label` items as group headings, pass an array of arrays so a label gets filtered out together with its group when searching.

### With icon in items

You can use the `icon` property to display an [Icon](https://ui.nuxt.com/docs/components/icon) inside the items.

```vue [SelectMenuItemsIconExample.vue]
<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'

const items = ref([
  {
    label: 'Backlog',
    value: 'backlog',
    icon: 'i-lucide-circle-help'
  },
  {
    label: 'Todo',
    value: 'todo',
    icon: 'i-lucide-circle-plus'
  },
  {
    label: 'In Progress',
    value: 'in_progress',
    icon: 'i-lucide-circle-arrow-up'
  },
  {
    label: 'Done',
    value: 'done',
    icon: 'i-lucide-circle-check'
  }
] satisfies SelectMenuItem[])

const value = ref(items.value[0])
</script>

<template>
  <USelectMenu v-model="value" :icon="value?.icon" :items="items" class="w-48" />
</template>
```

> [!TIP]
> 
> You can also use the `#leading` slot to display the selected icon.

### With avatar in items

You can use the `avatar` property to display an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the items.

```vue [SelectMenuItemsAvatarExample.vue]
<script setup lang="ts">
import type { SelectMenuItem } from '@nuxt/ui'

const items = ref([
  {
    label: 'benjamincanac',
    value: 'benjamincanac',
    avatar: {
      src: 'https://github.com/benjamincanac.png',
      alt: 'benjamincanac',
      loading: 'lazy' as const
    }
  },
  {
    label: 'romhml',
    value: 'romhml',
    avatar: {
      src: 'https://github.com/romhml.png',
      alt: 'romhml',
      loading: 'lazy' as const
    }
  },
  {
    label: 'noook',
    value: 'noook',
    avatar: {
      src: 'https://github.com/noook.png',
      alt: 'noook',
      loading: 'lazy' as const
    }
  },
  {
    label: 'sandros94',
    value: 'sandros94',
    avatar: {
      src: 'https://github.com/sandros94.png',
      alt: 'sandros94',
      loading: 'lazy' as const
    }
  }
] satisfies SelectMenuItem[])

const value = ref(items.value[0])
</script>

<template>
  <USelectMenu v-model="value" :avatar="value?.avatar" :items="items" class="w-48" />
</template>
```

> [!TIP]
> 
> You can also use the `#leading` slot to display the selected avatar.

### With chip in items

You can use the `chip` property to display a [Chip](https://ui.nuxt.com/docs/components/chip) inside the items.

```vue [SelectMenuItemsChipExample.vue]
<script setup lang="ts">
import type { SelectMenuItem, ChipProps } from '@nuxt/ui'

const items = ref([
  {
    label: 'bug',
    value: 'bug',
    chip: {
      color: 'error'
    }
  },
  {
    label: 'feature',
    value: 'feature',
    chip: {
      color: 'success'
    }
  },
  {
    label: 'enhancement',
    value: 'enhancement',
    chip: {
      color: 'info'
    }
  }
] satisfies SelectMenuItem[])

const value = ref(items.value[0])
</script>

<template>
  <USelectMenu v-model="value" :items="items" class="w-48">
    <template #leading="{ modelValue, ui }">
      <UChip
        v-if="modelValue"
        v-bind="modelValue.chip"
        inset
        standalone
        :size="(ui.itemLeadingChipSize() as ChipProps['size'])"
        :class="ui.itemLeadingChip()"
      />
    </template>
  </USelectMenu>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
