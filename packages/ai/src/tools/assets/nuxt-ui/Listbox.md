# UListbox

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Listbox component
 */
interface ListboxProps {
  id?: string | undefined;
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "xs" | "lg" | "xl" | undefined;
  /**
   * The items to display in the list.
   */
  items?: T | undefined;
  /**
   * The controlled value of the Listbox. Can be bound with `v-model`.
   */
  modelValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, undefined>, Mod>, Mod>, Mod> | undefined;
  modelModifiers?: Mod | undefined;
  /**
   * The default value when not controlled.
   */
  defaultValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, undefined>, Mod>, Mod>, Mod> | undefined;
  /**
   * Whether multiple items can be selected.
   * @default false
   */
  multiple?: M | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the value instead of the object itself.
   * @default undefined
   */
  valueKey?: VK | undefined;
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
   * Whether the list is in a loading state.
   */
  loading?: boolean | undefined;
  /**
   * The icon displayed when loading.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
  /**
   * Whether to display a filter input or not.
   * Can be an object to pass additional props to the input.
   * `{ placeholder: 'Search...', variant: 'none' }`{lang="ts-type"}
   * @default false
   */
  filter?: boolean | Omit<InputProps<AcceptableValue, ModelModifiers>, "modelValue" | "defaultValue"> | undefined;
  /**
   * The fields to filter by.
   * @default [labelKey]
   */
  filterFields?: string[] | undefined;
  /**
   * When `true`, disable the default filters, useful for custom filtering (useAsyncData, useFetch, etc.).
   * @default false
   */
  ignoreFilter?: boolean | undefined;
  /**
   * The icon displayed when an item is selected.
   * @default appConfig.ui.icons.check
   */
  selectedIcon?: any;
  /**
   * Enable virtualization for large lists.
   * @default false
   */
  virtualize?: boolean | { overscan?: number | undefined; estimateSize?: number | ((index: number) => number) | undefined; } | undefined;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  ui?: { root?: SlotClass; input?: SlotClass; content?: SlotClass; group?: SlotClass; label?: SlotClass; separator?: SlotClass; empty?: SlotClass; loading?: SlotClass; loadingIcon?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemLeadingChip?: SlotClass; itemLeadingChipSize?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; itemTrailing?: SlotClass; itemTrailingIcon?: SlotClass; } | undefined;
  /**
   * Use this to compare objects by a particular field, or pass your own comparison function for complete control over how objects are compared.
   */
  by?: string | (a: AcceptableValue, b: AcceptableValue): boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with listbox
   */
  disabled?: boolean | undefined;
  /**
   * When `true`, hover over item will trigger highlight
   * @default true
   */
  highlightOnHover?: boolean | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * The orientation of the listbox. <br>Mainly so arrow navigation is done accordingly (left & right vs. up & down)
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * How multiple selection should behave in the collection.
   * @default 'toggle'
   */
  selectionBehavior?: "replace" | "toggle" | undefined;
  /**
   * @default ''
   */
  searchTerm?: string | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Listbox component
 */
interface ListboxSlots {
  loading(): any;
  empty(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-description(): any;
  item-trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Listbox component
 */
interface ListboxEmits {
  entryFocus: (payload: [event: CustomEvent<any>]) => void;
  highlight: (payload: [payload: { ref: HTMLElement; value: AcceptableValue; } | undefined]) => void;
  leave: (payload: [event: Event]) => void;
  change: (payload: [event: Event]) => void;
  update:modelValue: (payload: [value: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, undefined>, Mod>, Mod>, Mod>]) => void;
  update:searchTerm: (payload: [value: string]) => void;
}
```

## Composition

Parts placed by name: `#loading`, `#empty`, `#item`, `#item-leading`, `#item-label`, `#item-description`, `#item-trailing`.

## Usage

Use the `v-model` directive to control the value of the Listbox or the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "France",
    icon: "i-lucide-map-pin",
    value: "FR"
  },
  {
    label: "Germany",
    icon: "i-lucide-map-pin",
    value: "DE"
  },
  {
    label: "Italy",
    icon: "i-lucide-map-pin",
    value: "IT"
  },
  {
    label: "Spain",
    icon: "i-lucide-map-pin",
    value: "ES"
  },
  {
    label: "Netherlands",
    icon: "i-lucide-map-pin",
    value: "NL"
  },
  {
    label: "Poland",
    icon: "i-lucide-map-pin",
    value: "PL"
  },
  {
    label: "Belgium",
    icon: "i-lucide-map-pin",
    value: "BE"
  },
  {
    label: "Portugal",
    icon: "i-lucide-map-pin",
    value: "PT"
  },
  {
    label: "Austria",
    icon: "i-lucide-map-pin",
    value: "AT"
  },
  {
    label: "Sweden",
    icon: "i-lucide-map-pin",
    value: "SE"
  }
])
const value = ref({
  label: "France",
  icon: "i-lucide-map-pin",
  value: "FR"
})
</script>

<template>
  <UListbox v-model="value" :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`
- [`description?: string`](#with-description-in-items)
- [`type?: "label" | "separator" | "item"`](#with-items-type)
- [`icon?: string`](#with-icon-in-items)
- [`avatar?: AvatarProps`](#with-avatar-in-items)
- [`chip?: ChipProps`](#with-chip-in-items)
- `disabled?: boolean`
- `onSelect?: (e: Event) => void`
- `class?: any`
- `ui?: { label?: ClassNameValue, separator?: ClassNameValue, item?: ClassNameValue, itemLeadingIcon?: ClassNameValue, ... }`

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "France",
    description: "The Hexagon",
    icon: "i-lucide-map-pin",
    value: "FR"
  },
  {
    label: "Germany",
    description: "The Federal Republic",
    icon: "i-lucide-map-pin",
    value: "DE"
  },
  {
    label: "Italy",
    description: "The Boot",
    icon: "i-lucide-map-pin",
    value: "IT"
  },
  {
    label: "Spain",
    description: "The Bull Skin",
    icon: "i-lucide-map-pin",
    value: "ES"
  }
])
</script>

<template>
  <UListbox :items="items" />
</template>
```

You can also pass an array of arrays to the `items` prop to display separated groups of items.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[][]>([
  [
    {
      label: "France",
      icon: "i-lucide-map-pin",
      value: "FR"
    },
    {
      label: "Germany",
      icon: "i-lucide-map-pin",
      value: "DE"
    },
    {
      label: "Italy",
      icon: "i-lucide-map-pin",
      value: "IT"
    }
  ],
  [
    {
      label: "Brazil",
      icon: "i-lucide-map-pin",
      value: "BR"
    },
    {
      label: "Argentina",
      icon: "i-lucide-map-pin",
      value: "AR"
    }
  ]
])
</script>

<template>
  <UListbox :items="items" />
</template>
```

### Multiple

Use the `multiple` prop to allow selecting multiple items. When enabled, the `v-model` will be an array.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "France",
    icon: "i-lucide-map-pin",
    value: "FR"
  },
  {
    label: "Germany",
    icon: "i-lucide-map-pin",
    value: "DE"
  },
  {
    label: "Italy",
    icon: "i-lucide-map-pin",
    value: "IT"
  },
  {
    label: "Spain",
    icon: "i-lucide-map-pin",
    value: "ES"
  }
])
</script>

<template>
  <UListbox multiple :items="items" />
</template>
```

### Value Key

You can choose to bind a single property of the object rather than the whole object by using the `value-key` prop. Defaults to `undefined`.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "France",
    icon: "i-lucide-map-pin",
    value: "FR"
  },
  {
    label: "Germany",
    icon: "i-lucide-map-pin",
    value: "DE"
  },
  {
    label: "Italy",
    icon: "i-lucide-map-pin",
    value: "IT"
  },
  {
    label: "Spain",
    icon: "i-lucide-map-pin",
    value: "ES"
  }
])
const value = ref("FR")
</script>

<template>
  <UListbox v-model="value" value-key="value" :items="items" class="w-full" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With items type

You can use the `type` property with `separator` to display a separator between items or `label` to display a label.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[][]>([
  [
    {
      type: "label",
      label: "Fruits"
    },
    {
      label: "Apple"
    },
    {
      label: "Banana"
    },
    {
      label: "Blueberry"
    },
    {
      label: "Grapes"
    },
    {
      label: "Pineapple"
    }
  ],
  [
    {
      type: "label",
      label: "Vegetables"
    },
    {
      label: "Aubergine"
    },
    {
      label: "Broccoli"
    },
    {
      label: "Carrot"
    },
    {
      label: "Courgette"
    },
    {
      label: "Leek"
    }
  ]
])
</script>

<template>
  <UListbox :items="items" />
</template>
```

> [!NOTE]
> 
> When using `label` items as group headings, pass an array of arrays so a label gets filtered out together with its group when searching.

### With icon in items

You can use the `icon` property to display an [Icon](https://ui.nuxt.com/docs/components/icon) inside the items.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "Backlog",
    icon: "i-lucide-circle-help",
    value: "backlog"
  },
  {
    label: "Todo",
    icon: "i-lucide-circle-plus",
    value: "todo"
  },
  {
    label: "In Progress",
    icon: "i-lucide-circle-arrow-up",
    value: "in_progress"
  },
  {
    label: "Done",
    icon: "i-lucide-circle-check",
    value: "done"
  }
])
</script>

<template>
  <UListbox :items="items" />
</template>
```

### With avatar in items

You can use the `avatar` property to display an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the items.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "benjamincanac",
    avatar: {
      src: "https://github.com/benjamincanac.png"
    }
  },
  {
    label: "romhml",
    avatar: {
      src: "https://github.com/romhml.png"
    }
  },
  {
    label: "atinux",
    avatar: {
      src: "https://github.com/atinux.png"
    }
  },
  {
    label: "HugoRCD",
    avatar: {
      src: "https://github.com/HugoRCD.png"
    }
  }
])
</script>

<template>
  <UListbox :items="items" />
</template>
```

### With chip in items

You can use the `chip` property to display a [Chip](https://ui.nuxt.com/docs/components/chip) inside the items.

```vue
<script setup lang="ts">
import type { ListboxItem } from '@nuxt/ui'

const items = ref<ListboxItem[]>([
  {
    label: "bug",
    chip: {
      color: "error"
    }
  },
  {
    label: "feature",
    chip: {
      color: "success"
    }
  },
  {
    label: "enhancement",
    chip: {
      color: "info"
    }
  }
])
</script>

<template>
  <UListbox :items="items" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
