# UTree

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Tree component
 */
interface TreeProps {
  /**
   * The element or component this component should render as.
   * @default 'ul'
   */
  as?: any;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'md'
   */
  size?: "md" | "xs" | "sm" | "lg" | "xl" | undefined;
  /**
   * This function is passed the index of each item and should return a unique key for that item
   */
  getKey?: (val: T[number]): string | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  /**
   * The icon displayed on the right side of a parent node.
   * @default appConfig.ui.icons.chevronDown
   */
  trailingIcon?: any;
  /**
   * The icon displayed when a parent node is expanded.
   * @default appConfig.ui.icons.folderOpen
   */
  expandedIcon?: any;
  /**
   * The icon displayed when a parent node is collapsed.
   * @default appConfig.ui.icons.folder
   */
  collapsedIcon?: any;
  items?: T | undefined;
  /**
   * The controlled value of the Tree. Can be bind as `v-model`.
   */
  modelValue?: M extends true ? T[number][] : T[number] | undefined;
  /**
   * The value of the Tree when initially rendered. Use when you do not need to control the state of the Tree.
   */
  defaultValue?: M extends true ? T[number][] : T[number] | undefined;
  /**
   * Whether multiple options can be selected or not.
   */
  multiple?: M | undefined;
  /**
   * Use nested DOM structure (children inside parents) vs flattened structure (all items at same level).
   * When `virtualize` is enabled, this is automatically set to `false`.
   * @default true
   */
  nested?: boolean | undefined;
  /**
   * Enable virtualization for large lists.
   * Note: when enabled, the tree structure is flattened like if `nested` was set to `false`.
   * @default false
   */
  virtualize?: boolean | { overscan?: number | undefined; estimateSize?: number | ((index: number) => number) | undefined; } | undefined;
  onSelect?: (e: SelectEvent<T[number]>, item: T[number]): void | undefined;
  onToggle?: (e: ToggleEvent<T[number]>, item: T[number]): void | undefined;
  ui?: { root?: SlotClass; item?: SlotClass; listWithChildren?: SlotClass; itemWithChildren?: SlotClass; link?: SlotClass; linkLeadingIcon?: SlotClass; linkLabel?: SlotClass; linkTrailing?: SlotClass; linkTrailingIcon?: SlotClass; } | undefined;
  /**
   * The controlled value of the expanded item. Can be binded with `v-model`.
   */
  expanded?: string[] | undefined;
  /**
   * The value of the expanded tree when initially rendered. Use when you do not need to control the state of the expanded tree
   */
  defaultExpanded?: string[] | undefined;
  /**
   * How multiple selection should behave in the collection.
   */
  selectionBehavior?: "replace" | "toggle" | undefined;
  /**
   * When `true`, selecting parent will select the descendants. Requires `multiple` to be `true`.
   */
  propagateSelect?: boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with tree
   */
  disabled?: boolean | undefined;
  /**
   * When `true`, selecting children will update the parent state. Requires `multiple` to be `true`.
   */
  bubbleSelect?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Tree component
 */
interface TreeSlots {
  item-wrapper(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Tree component
 */
interface TreeEmits {
  update:modelValue: (payload: [val: M extends true ? T[number][] : T[number]]) => void;
  update:expanded: (payload: [val: string[]]) => void;
}
```

## Composition

Parts placed by name: `#item-wrapper`, `#item`, `#item-leading`, `#item-label`, `#item-trailing`.

Also written in the docs and absent from the interface above — one per column or item: `#app`.

## Usage

Use the Tree component to display a hierarchical structure of items.

```vue
<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

const items = ref<TreeItem[]>([
  {
    label: "app/",
    defaultExpanded: true,
    children: [
      {
        label: "composables/",
        children: [
          {
            label: "useAuth.ts",
            icon: "i-vscode-icons-file-type-typescript"
          },
          {
            label: "useUser.ts",
            icon: "i-vscode-icons-file-type-typescript"
          }
        ]
      },
      {
        label: "components/",
        defaultExpanded: true,
        children: [
          {
            label: "Card.vue",
            icon: "i-vscode-icons-file-type-vue"
          },
          {
            label: "Button.vue",
            icon: "i-vscode-icons-file-type-vue"
          }
        ]
      }
    ]
  },
  {
    label: "app.vue",
    icon: "i-vscode-icons-file-type-vue"
  },
  {
    label: "nuxt.config.ts",
    icon: "i-vscode-icons-file-type-nuxt"
  }
])
</script>

<template>
  <UTree :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `icon?: string`
- `label?: string`
- `trailingIcon?: string`
- `defaultExpanded?: boolean`
- `disabled?: boolean`
- `slot?: string`
- `children?: TreeItem[]`
- `onToggle?: (e: TreeItemToggleEvent<TreeItem>) => void`
- `onSelect?: (e: TreeItemSelectEvent<TreeItem>) => void`
- `class?: any`
- `ui?: { item?: ClassNameValue, itemWithChildren?: ClassNameValue, link?: ClassNameValue, linkLeadingIcon?: ClassNameValue, linkLabel?: ClassNameValue, linkTrailing?: ClassNameValue, linkTrailingIcon?: ClassNameValue, listWithChildren?: ClassNameValue }`

> [!NOTE]
> 
> A unique identifier is required for each item. The component will use the `label` prop as identifier if no `get-key` is provided. Ideally you should provide a `get-key` function prop to return a unique identifier. Alternatively, you can use the `labelKey` prop to specify which property to use as the unique identifier.

```vue
<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

const items = ref<TreeItem[]>([
  {
    label: "app/",
    defaultExpanded: true,
    children: [
      {
        label: "composables/",
        children: [
          {
            label: "useAuth.ts",
            icon: "i-vscode-icons-file-type-typescript"
          },
          {
            label: "useUser.ts",
            icon: "i-vscode-icons-file-type-typescript"
          }
        ]
      },
      {
        label: "components/",
        defaultExpanded: true,
        children: [
          {
            label: "Card.vue",
            icon: "i-vscode-icons-file-type-vue"
          },
          {
            label: "Button.vue",
            icon: "i-vscode-icons-file-type-vue"
          }
        ]
      }
    ]
  },
  {
    label: "app.vue",
    icon: "i-vscode-icons-file-type-vue"
  },
  {
    label: "nuxt.config.ts",
    icon: "i-vscode-icons-file-type-nuxt"
  }
])
</script>

<template>
  <UTree :items="items" />
</template>
```

### Multiple

Use the `multiple` prop to allow multiple item selections.

```vue
<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

const items = ref<TreeItem[]>([
  {
    label: "app/",
    defaultExpanded: true,
    children: [
      {
        label: "composables/",
        children: [
          {
            label: "useAuth.ts",
            icon: "i-vscode-icons-file-type-typescript"
          },
          {
            label: "useUser.ts",
            icon: "i-vscode-icons-file-type-typescript"
          }
        ]
      },
      {
        label: "components/",
        defaultExpanded: true,
        children: [
          {
            label: "Card.vue",
            icon: "i-vscode-icons-file-type-vue"
          },
          {
            label: "Button.vue",
            icon: "i-vscode-icons-file-type-vue"
          }
        ]
      }
    ]
  },
  {
    label: "app.vue",
    icon: "i-vscode-icons-file-type-vue"
  },
  {
    label: "nuxt.config.ts",
    icon: "i-vscode-icons-file-type-nuxt"
  }
])
</script>

<template>
  <UTree multiple :items="items" />
</template>
```

### Nested `4.1+`

Use the `nested` prop to control whether the Tree is rendered with nested structure or as a flat list. Defaults to `true`.

```vue
<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

const items = ref<TreeItem[]>([
  {
    label: "app/",
    defaultExpanded: true,
    children: [
      {
        label: "composables/",
        children: [
          {
            label: "useAuth.ts",
            icon: "i-vscode-icons-file-type-typescript"
          },
          {
            label: "useUser.ts",
            icon: "i-vscode-icons-file-type-typescript"
          }
        ]
      },
      {
        label: "components/",
        defaultExpanded: true,
        children: [
          {
            label: "Card.vue",
            icon: "i-vscode-icons-file-type-vue"
          },
          {
            label: "Button.vue",
            icon: "i-vscode-icons-file-type-vue"
          }
        ]
      }
    ]
  },
  {
    label: "app.vue",
    icon: "i-vscode-icons-file-type-vue"
  },
  {
    label: "nuxt.config.ts",
    icon: "i-vscode-icons-file-type-nuxt"
  }
])
</script>

<template>
  <UTree :nested="false" :items="items" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control selected item(s)

You can control the selected item(s) by using the `default-value` prop or the `v-model` directive.

```vue [TreeModelValueExample.vue]
<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

const items: TreeItem[] = [
  {
    label: 'app/',
    defaultExpanded: true,
    children: [
      {
        label: 'composables/',
        children: [
          { label: 'useAuth.ts', icon: 'i-vscode-icons-file-type-typescript' },
          { label: 'useUser.ts', icon: 'i-vscode-icons-file-type-typescript' }
        ]
      },
      {
        label: 'components/',
        defaultExpanded: true,
        children: [
          { label: 'Card.vue', icon: 'i-vscode-icons-file-type-vue' },
          { label: 'Button.vue', icon: 'i-vscode-icons-file-type-vue' }
        ]
      }
    ]
  },
  { label: 'app.vue', icon: 'i-vscode-icons-file-type-vue' },
  { label: 'nuxt.config.ts', icon: 'i-vscode-icons-file-type-nuxt' }
]

const value = ref()
</script>

<template>
  <UTree v-model="value" :items="items" />
</template>
```

> [!TIP]
> 
> Use the `get-key` prop to change the function used to get the unique key from each item when a `v-model` or `default-value` is provided.

If you want to prevent an item from being selected, you can use the `item.onSelect()` property or the global `select` event:

```vue [TreeOnSelectExample.vue]
<script setup lang="ts">
import type { TreeItemSelectEvent } from 'reka-ui'
import type { TreeItem } from '@nuxt/ui'

const items: TreeItem[] = [
  {
    label: 'app/',
    defaultExpanded: true,
    onSelect: (e: Event) => {
      e.preventDefault()
    },
    children: [
      {
        label: 'composables/',
        children: [
          { label: 'useAuth.ts', icon: 'i-vscode-icons-file-type-typescript' },
          { label: 'useUser.ts', icon: 'i-vscode-icons-file-type-typescript' }
        ]
      },
      {
        label: 'components/',
        defaultExpanded: true,
        children: [
          { label: 'Card.vue', icon: 'i-vscode-icons-file-type-vue' },
          { label: 'Button.vue', icon: 'i-vscode-icons-file-type-vue' }
        ]
      }
    ]
  },
  { label: 'app.vue', icon: 'i-vscode-icons-file-type-vue' },
  { label: 'nuxt.config.ts', icon: 'i-vscode-icons-file-type-nuxt' }
]

function onSelect(e: TreeItemSelectEvent<TreeItem>) {
  if (e.detail.originalEvent.type === 'click') {
    e.preventDefault()
  }
}
</script>

<template>
  <UTree :items="items" @select="onSelect" />
</template>
```

> [!NOTE]
> 
> This lets you expand or collapse a parent item without selecting it.

### Control expanded items

You can control the expanded items by using the `default-expanded` prop or the `v-model` directive.

```vue [TreeExpandedExample.vue]
<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'

const items = [
  {
    label: 'app/',
    id: 'app',
    children: [
      {
        label: 'composables/',
        id: 'app/composables',
        children: [
          { label: 'useAuth.ts', icon: 'i-vscode-icons-file-type-typescript' },
          { label: 'useUser.ts', icon: 'i-vscode-icons-file-type-typescript' }
        ]
      },
      {
        label: 'components/',
        id: 'app/components',
        children: [
          { label: 'Card.vue', icon: 'i-vscode-icons-file-type-vue' },
          { label: 'Button.vue', icon: 'i-vscode-icons-file-type-vue' }
        ]
      }
    ]
  },
  { label: 'app.vue', id: 'app.vue', icon: 'i-vscode-icons-file-type-vue' },
  { label: 'nuxt.config.ts', id: 'nuxt.config.ts', icon: 'i-vscode-icons-file-type-nuxt' }
] satisfies TreeItem[]

const expanded = ref(['app', 'app/composables'])
</script>

<template>
  <UTree v-model:expanded="expanded" :items="items" :get-key="i => i.id" />
</template>
```

If you want to prevent an item from being expanded, you can use the `item.onToggle()` property or the global `toggle` event:

```vue [TreeOnToggleExample.vue]
<script setup lang="ts">
import type { TreeItemToggleEvent } from 'reka-ui'
import type { TreeItem } from '@nuxt/ui'

const items: TreeItem[] = [
  {
    label: 'app/',
    defaultExpanded: true,
    onToggle: (e: Event) => {
      e.preventDefault()
    },
    children: [
      {
        label: 'composables/',
        children: [
          { label: 'useAuth.ts', icon: 'i-vscode-icons-file-type-typescript' },
          { label: 'useUser.ts', icon: 'i-vscode-icons-file-type-typescript' }
        ]
      },
      {
        label: 'components/',
        defaultExpanded: true,
        children: [
          { label: 'Card.vue', icon: 'i-vscode-icons-file-type-vue' },
          { label: 'Button.vue', icon: 'i-vscode-icons-file-type-vue' }
        ]
      }
    ]
  },
  { label: 'app.vue', icon: 'i-vscode-icons-file-type-vue' },
  { label: 'nuxt.config.ts', icon: 'i-vscode-icons-file-type-nuxt' }
]

function onToggle(e: TreeItemToggleEvent<TreeItem>) {
  if (e.detail.originalEvent.type === 'keydown') {
    e.preventDefault()
  }
}
</script>

<template>
  <UTree :items="items" @toggle="onToggle" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
