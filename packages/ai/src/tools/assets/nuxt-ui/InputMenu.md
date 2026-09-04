# UInputMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the InputMenu component
 */
interface InputMenuProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  id?: string | undefined;
  /**
   * @default 'text'
   */
  type?: "number" | "search" | "color" | "button" | "checkbox" | "date" | "datetime-local" | "email" | "file" | "hidden" | "image" | "month" | "password" | "radio" | "range" | "reset" | "submit" | "tel" | "text" | "time" | "url" | "week" | string & {} | undefined;
  /**
   * The placeholder text when the input is empty.
   */
  placeholder?: string | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "soft" | "outline" | "subtle" | "ghost" | "none" | undefined;
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "xs" | "lg" | "xl" | undefined;
  required?: boolean | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
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
   * The icon displayed to delete a tag.
   * Works only when `multiple` is `true`.
   * @default appConfig.ui.icons.close
   */
  deleteIcon?: any;
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
  content?: Omit<ComboboxContentProps, "as" | "asChild" | "forceMount"> & Partial<EmitsToProps<DismissableLayerEmits>> | undefined;
  /**
   * Display an arrow alongside the menu.
   * `{ rounded: true }`{lang="ts-type"}
   * @default false
   */
  arrow?: boolean | Omit<ComboboxArrowProps, "as" | "asChild"> | undefined;
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
   * The value of the InputMenu when initially rendered. Use when you do not need to control the state of the InputMenu.
   */
  defaultValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C> | undefined;
  /**
   * The controlled value of the InputMenu. Can be binded-with with `v-model`.
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
   * The behavior of the InputMenu.
   * - `combobox`: select one (or many) items from a list of suggestions.
   * - `autocomplete`: free-form text input with optional suggestions. The `modelValue` becomes the input text (`string`) instead of a selected item.
   * @default 'combobox'
   */
  mode?: "autocomplete" | "combobox" | undefined;
  /**
   * Determines if custom user input that does not exist in options can be added.
   * @default false
   */
  createItem?: boolean | "always" | { position?: "bottom" | "top" | undefined; when?: "empty" | "always" | undefined; } | undefined;
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
  ui?: { root?: SlotClass; base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; trailingClear?: SlotClass; arrow?: SlotClass; content?: SlotClass; viewport?: SlotClass; group?: SlotClass; empty?: SlotClass; label?: SlotClass; separator?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemLeadingChip?: SlotClass; itemLeadingChipSize?: SlotClass; itemTrailing?: SlotClass; itemTrailingIcon?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; tagsItem?: SlotClass; tagsItemText?: SlotClass; tagsItemDelete?: SlotClass; tagsItemDeleteIcon?: SlotClass; tagsInput?: SlotClass; } | undefined;
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
   * Whether to open the combobox when the input is clicked
   * @default `false`
   */
  openOnClick?: boolean | undefined;
  /**
   * Whether to open the combobox when the input is focused
   * @default `false`
   */
  openOnFocus?: boolean | undefined;
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
  enterKeyHint?: "search" | "enter" | "done" | "go" | "next" | "previous" | "send" | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  list?: string | undefined;
  readonly?: false | true | "true" | "false" | undefined;
  autocomplete?: string & {} | "on" | "off" | undefined;
  /**
   * @default ''
   */
  searchTerm?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input#attributes
> 
> This component also supports all native `<input>` HTML attributes.

### Slots

```ts
/**
 * Slots for the InputMenu component
 */
interface InputMenuSlots {
  leading(): any;
  trailing(): any;
  empty(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-description(): any;
  item-trailing(): any;
  tags-item-text(): any;
  tags-item-delete(): any;
  content-top(): any;
  content-bottom(): any;
  create-item-label(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the InputMenu component
 */
interface InputMenuEmits {
  update:open: (payload: [value: boolean]) => void;
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  focus: (payload: [event: FocusEvent]) => void;
  create: (payload: [item: string]) => void;
  clear: (payload: []) => void;
  highlight: (payload: [payload: { ref: HTMLElement; value: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C>; } | undefined]) => void;
  remove-tag: (payload: [item: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C>]) => void;
  update:modelValue: (payload: [value: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | IsClearUsed<M, C>]) => void;
  update:searchTerm: (payload: [value: string]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `inputRef` | `Ref<HTMLInputElement \| null>` |
| `viewportRef` | `Ref<HTMLDivElement \| null>` |

## Composition

Parts placed by name: `#empty`, `#item`, `#item-leading`, `#item-label`, `#item-description`, `#item-trailing`, `#tags-item-text`, `#tags-item-delete`, `#content-top`, `#content-bottom`, `#create-item-label`.

## Usage

Use the `v-model` directive to control the value of the InputMenu or the `default-value` prop to set the initial value when you do not need to control its state.

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
  <UInputMenu v-model="value" :items="items" />
</template>
```

> [!TIP]
> 
> Use this over an [`Input`](https://ui.nuxt.com/docs/components/input) to take advantage of Reka UI's [`Combobox`](https://reka-ui.com/docs/components/combobox) component that offers autocomplete capabilities.

> [!NOTE]
> 
> This component is similar to the [`SelectMenu`](https://ui.nuxt.com/docs/components/select-menu) but it's using an Input instead of a Select.

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
  <UInputMenu v-model="value" :items="items" />
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
- `ui?: { tagsItem?: ClassNameValue, tagsItemText?: ClassNameValue, tagsItemDelete?: ClassNameValue, tagsItemDeleteIcon?: ClassNameValue, label?: ClassNameValue, separator?: ClassNameValue, item?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingAvatarSize?: ClassNameValue, itemLeadingAvatar?: ClassNameValue, itemLeadingChip?: ClassNameValue, itemLeadingChipSize?: ClassNameValue, itemLabel?: ClassNameValue, itemTrailing?: ClassNameValue, itemTrailingIcon?: ClassNameValue }`

```vue
<script setup lang="ts">
import type { InputMenuItem } from '@nuxt/ui'

const items = ref<InputMenuItem[]>([
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
  <UInputMenu v-model="value" :items="items" />
</template>
```

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
  <UInputMenu v-model="value" :items="items" />
</template>
```

### Value Key

You can choose to bind a single property of the object rather than the whole object by using the `value-key` prop. Defaults to `undefined`.

```vue
<script setup lang="ts">
import type { InputMenuItem } from '@nuxt/ui'

const items = ref<InputMenuItem[]>([
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
  <UInputMenu v-model="value" value-key="id" :items="items" />
</template>
```

> [!TIP]
> 
> Use the `by` prop to compare objects by a field instead of reference when the `model-value` is an object.

### Multiple

Use the `multiple` prop to allow multiple selections, the selected items will be displayed as tags.

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
  <UInputMenu v-model="value" multiple :items="items" />
</template>
```

> [!CAUTION]
> 
> Ensure to pass an array to the `default-value` prop or the `v-model` directive.

### Delete Icon

With `multiple`, use the `delete-icon` prop to customize the delete [Icon](https://ui.nuxt.com/docs/components/icon) in the tags. Defaults to `i-lucide-x`.

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
  <UInputMenu v-model="value" multiple delete-icon="i-lucide-trash" :items="items" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.close` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.close` key.

### Placeholder

Use the `placeholder` prop to set a placeholder text.


_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With items type

You can use the `type` property with `separator` to display a separator between items or `label` to display a label.

```vue
<script setup lang="ts">
import type { InputMenuItem } from '@nuxt/ui'

const items = ref<InputMenuItem[]>([
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
  <UInputMenu v-model="value" :items="items" />
</template>
```

> [!NOTE]
> 
> When using `label` items as group headings, pass an array of arrays so a label gets filtered out together with its group when searching.

### With icon in items

You can use the `icon` property to display an [Icon](https://ui.nuxt.com/docs/components/icon) inside the items.

```vue [InputMenuItemsIconExample.vue]
<script setup lang="ts">
import type { InputMenuItem } from '@nuxt/ui'

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
] satisfies InputMenuItem[])

const value = ref(items.value[0])
</script>

<template>
  <UInputMenu v-model="value" :icon="value?.icon" :items="items" />
</template>
```

> [!TIP]
> 
> You can also use the `#leading` slot to display the selected icon.

### With avatar in items

You can use the `avatar` property to display an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the items.

```vue [InputMenuItemsAvatarExample.vue]
<script setup lang="ts">
import type { InputMenuItem } from '@nuxt/ui'

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
] satisfies InputMenuItem[])

const value = ref(items.value[0])
</script>

<template>
  <UInputMenu v-model="value" :avatar="value?.avatar" :items="items" />
</template>
```

> [!TIP]
> 
> You can also use the `#leading` slot to display the selected avatar.

### With chip in items

You can use the `chip` property to display a [Chip](https://ui.nuxt.com/docs/components/chip) inside the items.

```vue [InputMenuItemsChipExample.vue]
<script setup lang="ts">
import type { InputMenuItem, ChipProps } from '@nuxt/ui'

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
] satisfies InputMenuItem[])

const value = ref(items.value[0])
</script>

<template>
  <UInputMenu v-model="value" :items="items">
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
  </UInputMenu>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
