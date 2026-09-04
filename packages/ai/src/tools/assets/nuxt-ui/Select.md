# USelect

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Select component
 */
interface SelectProps {
  id?: string | undefined;
  /**
   * The placeholder text when the select is empty.
   */
  placeholder?: string | undefined;
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
   * The content of the menu.
   * @default { side: 'bottom', sideOffset: 8, collisionPadding: 8, position: 'popper' }
   */
  content?: Omit<SelectContentProps, "as" | "asChild" | "forceMount"> & Partial<EmitsToProps<SelectContentImplEmits>> | undefined;
  /**
   * Display an arrow alongside the menu.
   * `{ rounded: true }`{lang="ts-type"}
   * @default false
   */
  arrow?: boolean | Omit<SelectArrowProps, "as" | "asChild"> | undefined;
  /**
   * Render the menu in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * When `items` is an array of objects, select the field to use as the value.
   * @default 'value'
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
   * The value of the Select when initially rendered. Use when you do not need to control the state of the Select.
   */
  defaultValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | undefined;
  /**
   * The controlled value of the Select. Can be bind as `v-model`.
   */
  modelValue?: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod> | undefined;
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
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  ui?: { base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; value?: SlotClass; placeholder?: SlotClass; arrow?: SlotClass; content?: SlotClass; viewport?: SlotClass; group?: SlotClass; empty?: SlotClass; label?: SlotClass; separator?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemLeadingChip?: SlotClass; itemLeadingChipSize?: SlotClass; itemTrailing?: SlotClass; itemTrailingIcon?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; } | undefined;
  /**
   * When `true`, prevents the user from interacting with Select
   */
  disabled?: boolean | undefined;
  /**
   * The controlled open state of the Select. Can be bind as `v-model:open`.
   */
  open?: boolean | undefined;
  /**
   * The open state of the select when it is initially rendered. Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The value of the hidden native select option when the model value is nullish.
   */
  nullableValue?: string | undefined;
  /**
   * Native html input `autocomplete` attribute.
   */
  autocomplete?: string | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
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
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
> 
> This component also supports all native `<button>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Select component
 */
interface SelectSlots {
  leading(): any;
  default(): any;
  trailing(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-description(): any;
  item-trailing(): any;
  content-top(): any;
  content-bottom(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Select component
 */
interface SelectEmits {
  update:modelValue: (payload: [value: _Number<_Optional<_Nullable<GetModelValue<T, VK, M, ExcludeItem>, Mod>, Mod>, Mod>]) => void;
  update:open: (payload: [value: boolean]) => void;
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  focus: (payload: [event: FocusEvent]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `triggerRef` | `Ref<HTMLButtonElement \| null>` |
| `viewportRef` | `Ref<HTMLDivElement \| null>` |

## Composition

Parts placed by name: `#item`, `#item-leading`, `#item-label`, `#item-description`, `#item-trailing`, `#content-top`, `#content-bottom`.

## Usage

Use the `v-model` directive to control the value of the Select or the `default-value` prop to set the initial value when you do not need to control its state.

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
  <USelect v-model="value" :items="items" />
</template>
```

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
  <USelect v-model="value" :items="items" class="w-48" />
</template>
```

You can also pass an array of objects with the following properties:

- `label?: string`
- [`value?: string`](#value-key)
- [`type?: "label" | "separator" | "item"`](#with-items-type)
- [`icon?: string`](#with-icons-in-items)
- [`avatar?: AvatarProps`](#with-avatar-in-items)
- [`chip?: ChipProps`](#with-chip-in-items)
- `disabled?: boolean`
- `class?: any`
- `ui?: { label?: ClassNameValue, separator?: ClassNameValue, item?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingAvatarSize?: ClassNameValue, itemLeadingAvatar?: ClassNameValue, itemLeadingChipSize?: ClassNameValue, itemLeadingChip?: ClassNameValue, itemLabel?: ClassNameValue, itemTrailing?: ClassNameValue, itemTrailingIcon?: ClassNameValue }`

```vue
<script setup lang="ts">
import type { SelectItem } from '@nuxt/ui'

const items = ref<SelectItem[]>([
  {
    label: "Backlog",
    value: "backlog"
  },
  {
    label: "Todo",
    value: "todo"
  },
  {
    label: "In Progress",
    value: "in_progress"
  },
  {
    label: "Done",
    value: "done"
  }
])
const value = ref("backlog")
</script>

<template>
  <USelect v-model="value" :items="items" class="w-48" />
</template>
```

> [!CAUTION]
> 
> When using objects, you need to reference the `value` property of the object in the `v-model` directive or the `default-value` prop.

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
  <USelect v-model="value" :items="items" class="w-48" />
</template>
```

### Value Key

You can change the property that is used to set the value by using the `value-key` prop. Defaults to `value`.

```vue
<script setup lang="ts">
import type { SelectItem } from '@nuxt/ui'

const items = ref<SelectItem[]>([
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
const value = ref("backlog")
</script>

<template>
  <USelect v-model="value" value-key="id" :items="items" class="w-48" />
</template>
```

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
  <USelect v-model="value" multiple :items="items" class="w-48" />
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
  <USelect placeholder="Select status" :items="items" class="w-48" />
</template>
```

### Content

Use the `content` prop to control how the Select content is rendered, like its `align` or `side` for example.

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
  <USelect v-model="value" :content="{
  align: 'center',
  side: 'bottom',
  sideOffset: 8
}" :items="items" class="w-48" />
</template>
```

> [!NOTE]
> 
> These options only apply when `content.position` is `popper` (default).


_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With items type

You can use the `type` property with `separator` to display a separator between items or `label` to display a label.

```vue
<script setup lang="ts">
import type { SelectItem } from '@nuxt/ui'

const items = ref<SelectItem[]>([
  {
    type: "label",
    label: "Fruits"
  },
  "Apple",
  "Banana",
  "Blueberry",
  "Grapes",
  "Pineapple",
  {
    type: "separator"
  },
  {
    type: "label",
    label: "Vegetables"
  },
  "Aubergine",
  "Broccoli",
  "Carrot",
  "Courgette",
  "Leek"
])
const value = ref("Apple")
</script>

<template>
  <USelect v-model="value" :items="items" class="w-48" />
</template>
```

### With icon in items

You can use the `icon` property to display an [Icon](https://ui.nuxt.com/docs/components/icon) inside the items.

```vue [SelectItemsIconExample.vue]
<script setup lang="ts">
import type { SelectItem } from '@nuxt/ui'

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
] satisfies SelectItem[])

const value = ref(items.value[0]?.value)

const icon = computed(() => items.value.find(item => item.value === value.value)?.icon)
</script>

<template>
  <USelect v-model="value" :items="items" value-key="value" :icon="icon" class="w-48" />
</template>
```

> [!NOTE]
> 
> In this example, the icon is computed from the `value` property of the selected item.

> [!TIP]
> 
> You can also use the `#leading` slot to display the selected icon.

### With avatar in items

You can use the `avatar` property to display an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the items.

```vue [SelectItemsAvatarExample.vue]
<script setup lang="ts">
import type { SelectItem } from '@nuxt/ui'

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
] satisfies SelectItem[])

const value = ref(items.value[0]?.value)

const avatar = computed(() => items.value.find(item => item.value === value.value)?.avatar)
</script>

<template>
  <USelect v-model="value" :items="items" value-key="value" :avatar="avatar" class="w-48" />
</template>
```

> [!NOTE]
> 
> In this example, the avatar is computed from the `value` property of the selected item.

> [!TIP]
> 
> You can also use the `#leading` slot to display the selected avatar.

### With chip in items

You can use the `chip` property to display a [Chip](https://ui.nuxt.com/docs/components/chip) inside the items.

```vue [SelectItemsChipExample.vue]
<script setup lang="ts">
import type { SelectItem, ChipProps } from '@nuxt/ui'

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
] satisfies SelectItem[])

const value = ref(items.value[0]?.value)

function getChip(value: string) {
  return items.value.find(item => item.value === value)?.chip
}
</script>

<template>
  <USelect v-model="value" :items="items" value-key="value" class="w-48">
    <template #leading="{ modelValue, ui }">
      <UChip
        v-if="modelValue"
        v-bind="getChip(modelValue)"
        inset
        standalone
        :size="(ui.itemLeadingChipSize() as ChipProps['size'])"
        :class="ui.itemLeadingChip()"
      />
    </template>
  </USelect>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
