# UContextMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ContextMenu component
 */
interface ContextMenuProps {
  /**
   * @default 'md'
   */
  size?: "sm" | "md" | "xs" | "lg" | "xl" | undefined;
  items?: T | undefined;
  /**
   * The icon displayed when an item is checked.
   * @default appConfig.ui.icons.check
   */
  checkedIcon?: any;
  /**
   * The icon displayed when an item is loading.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
  /**
   * The icon displayed when the item is an external link.
   * Set to `false` to hide the external icon.
   * @default true
   */
  externalIcon?: any;
  /**
   * The content of the menu.
   */
  content?: Omit<ContextMenuContentProps, "as" | "asChild" | "forceMount"> & Partial<EmitsToProps<MenuContentEmits>> | undefined;
  /**
   * Render the menu in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
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
  disabled?: boolean | undefined;
  ui?: { content?: SlotClass; viewport?: SlotClass; group?: SlotClass; label?: SlotClass; separator?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemTrailing?: SlotClass; itemTrailingIcon?: SlotClass; itemTrailingKbds?: SlotClass; itemTrailingKbdsSize?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; itemLabelExternalIcon?: SlotClass; } | undefined;
  /**
   * The modality of the dropdown menu.
   * 
   * When set to `true`, interaction with outside elements will be disabled and only menu content will be visible to screen readers.
   * @default true
   */
  modal?: boolean | undefined;
  /**
   * The duration from when the trigger is pressed until the menu opens.
   * @default 700
   */
  pressOpenDelay?: number | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ContextMenu component
 */
interface ContextMenuSlots {
  default(): any;
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
 * Emitted events for the ContextMenu component
 */
interface ContextMenuEmits {
  update:open: (payload: [payload: boolean]) => void;
}
```

## Composition

Parts placed by name: `#item`, `#item-leading`, `#item-label`, `#item-description`, `#item-trailing`, `#content-top`, `#content-bottom`.

Also written in the docs and absent from the interface above — one per column or item: `#refresh-label`, `#refresh-trailing`.

## Usage

Use anything you like in the default slot of the ContextMenu, and right-click on it to display the menu.

```vue
<script setup lang="ts">
import type { ContextMenuItem } from '@nuxt/ui'

const items = ref<ContextMenuItem[][]>([
  [
    {
      label: "Appearance",
      children: [
        {
          label: "System",
          icon: "i-lucide-monitor"
        },
        {
          label: "Light",
          icon: "i-lucide-sun"
        },
        {
          label: "Dark",
          icon: "i-lucide-moon"
        }
      ]
    }
  ],
  [
    {
      label: "Show Sidebar",
      kbds: [
        "meta",
        "s"
      ]
    },
    {
      label: "Show Toolbar",
      kbds: [
        "shift",
        "meta",
        "d"
      ]
    },
    {
      label: "Collapse Pinned Tabs",
      disabled: true
    }
  ],
  [
    {
      label: "Refresh the Page"
    },
    {
      label: "Clear Cookies and Refresh"
    },
    {
      label: "Clear Cache and Refresh"
    },
    {
      type: "separator"
    },
    {
      label: "Developer",
      children: [
        [
          {
            label: "View Source",
            kbds: [
              "meta",
              "shift",
              "u"
            ]
          },
          {
            label: "Developer Tools",
            kbds: [
              "option",
              "meta",
              "i"
            ]
          },
          {
            label: "Inspect Elements",
            kbds: [
              "option",
              "meta",
              "c"
            ]
          }
        ],
        [
          {
            label: "JavaScript Console",
            kbds: [
              "option",
              "meta",
              "j"
            ]
          }
        ]
      ]
    }
  ]
])
</script>

<template>
  <UContextMenu :items="items">
    <div class="flex items-center justify-center rounded-md border border-dashed border-accented text-sm aspect-video w-72">
      Right click here
    </div>
  </UContextMenu>
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`
- `icon?: string`
- `avatar?: AvatarProps`
- `kbds?: string[] | KbdProps[]`
- [`type?: "link" | "label" | "separator" | "checkbox"`](#with-checkbox-items)
- [`color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral"`](#with-color-items)
- [`checked?: boolean`](#with-checkbox-items)
- `disabled?: boolean`
- [`slot?: string`](#with-custom-slot)
- `onSelect?: (e: Event) => void`
- [`onUpdateChecked?: (checked: boolean) => void`](#with-checkbox-items)
- `children?: ContextMenuItem[] | ContextMenuItem[][]`
- `class?: any`
- `ui?: { item?: ClassNameValue, label?: ClassNameValue, separator?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingAvatarSize?: ClassNameValue, itemLeadingAvatar?: ClassNameValue, itemLabel?: ClassNameValue, itemLabelExternalIcon?: ClassNameValue, itemTrailing?: ClassNameValue, itemTrailingIcon?: ClassNameValue, itemTrailingKbds?: ClassNameValue, itemTrailingKbdsSize?: ClassNameValue }`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { ContextMenuItem } from '@nuxt/ui'

const items = ref<ContextMenuItem[][]>([
  [
    {
      label: "Appearance",
      children: [
        {
          label: "System",
          icon: "i-lucide-monitor"
        },
        {
          label: "Light",
          icon: "i-lucide-sun"
        },
        {
          label: "Dark",
          icon: "i-lucide-moon"
        }
      ]
    }
  ],
  [
    {
      label: "Show Sidebar",
      kbds: [
        "meta",
        "s"
      ]
    },
    {
      label: "Show Toolbar",
      kbds: [
        "shift",
        "meta",
        "d"
      ]
    },
    {
      label: "Collapse Pinned Tabs",
      disabled: true
    }
  ],
  [
    {
      label: "Refresh the Page"
    },
    {
      label: "Clear Cookies and Refresh"
    },
    {
      label: "Clear Cache and Refresh"
    },
    {
      type: "separator"
    },
    {
      label: "Developer",
      children: [
        [
          {
            label: "View Source",
            kbds: [
              "meta",
              "shift",
              "u"
            ]
          },
          {
            label: "Developer Tools",
            kbds: [
              "option",
              "meta",
              "i"
            ]
          },
          {
            label: "Inspect Elements",
            kbds: [
              "option",
              "meta",
              "c"
            ]
          }
        ],
        [
          {
            label: "JavaScript Console",
            kbds: [
              "option",
              "meta",
              "j"
            ]
          }
        ]
      ]
    }
  ]
])
</script>

<template>
  <UContextMenu :items="items" :ui="{
  content: 'w-48'
}">
    <div class="flex items-center justify-center rounded-md border border-dashed border-accented text-sm aspect-video w-72">
      Right click here
    </div>
  </UContextMenu>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With checkbox items

You can use the `type` property with `checkbox` and use the `checked` / `onUpdateChecked` properties to control the checked state of the item.

```vue [ContextMenuCheckboxItemsExample.vue]
<script setup lang="ts">
import type { ContextMenuItem } from '@nuxt/ui'

const showSidebar = ref(true)
const showToolbar = ref(false)

const items = computed<ContextMenuItem[]>(() => [{
  label: 'View',
  type: 'label' as const
}, {
  type: 'separator' as const
}, {
  label: 'Show Sidebar',
  type: 'checkbox' as const,
  checked: showSidebar.value,
  onUpdateChecked(checked: boolean) {
    showSidebar.value = checked
  },
  onSelect(e: Event) {
    e.preventDefault()
  }
}, {
  label: 'Show Toolbar',
  type: 'checkbox' as const,
  checked: showToolbar.value,
  onUpdateChecked(checked: boolean) {
    showToolbar.value = checked
  }
}, {
  label: 'Collapse Pinned Tabs',
  type: 'checkbox' as const,
  disabled: true
}])
</script>

<template>
  <UContextMenu :items="items" :ui="{ content: 'w-48' }">
    <div class="flex items-center justify-center rounded-md border border-dashed border-accented text-sm aspect-video w-72">
      Right click here
    </div>
  </UContextMenu>
</template>
```

> [!NOTE]
> 
> To ensure reactivity for the `checked` state of items, it's recommended to wrap your `items` array inside a `computed`.

### With color items

You can use the `color` property to highlight certain items with a color.

```vue [ContextMenuColorItemsExample.vue]
<script setup lang="ts">
import type { ContextMenuItem } from '@nuxt/ui'

const items: ContextMenuItem[][] = [
  [
    {
      label: 'View',
      icon: 'i-lucide-eye'
    },
    {
      label: 'Copy',
      icon: 'i-lucide-copy'
    },
    {
      label: 'Edit',
      icon: 'i-lucide-pencil'
    }
  ],
  [
    {
      label: 'Delete',
      color: 'error' as const,
      icon: 'i-lucide-trash'
    }
  ]
]
</script>

<template>
  <UContextMenu :items="items" :ui="{ content: 'w-48' }">
    <div class="flex items-center justify-center rounded-md border border-dashed border-accented text-sm aspect-video w-72">
      Right click here
    </div>
  </UContextMenu>
</template>
```

### With custom slot

Use the `slot` property to customize a specific item.

You will have access to the following slots:

- `#{{ item.slot }}`
- `#{{ item.slot }}-leading`
- `#{{ item.slot }}-label`
- `#{{ item.slot }}-trailing`

```vue [ContextMenuCustomSlotExample.vue]
<script setup lang="ts">
import type { ContextMenuItem } from '@nuxt/ui'

const loading = ref(true)

const items = [
  {
    label: 'Refresh the Page',
    slot: 'refresh' as const
  },
  {
    label: 'Clear Cookies and Refresh'
  },
  {
    label: 'Clear Cache and Refresh'
  }
] satisfies ContextMenuItem[]
</script>

<template>
  <UContextMenu :items="items" :ui="{ content: 'w-48' }">
    <div class="flex items-center justify-center rounded-md border border-dashed border-accented text-sm aspect-video w-72">
      Right click here
    </div>

    <template #refresh-label>
      {{ loading ? 'Refreshing...' : 'Refresh the Page' }}
    </template>

    <template #refresh-trailing>
      <UIcon v-if="loading" name="i-lucide-loader-circle" class="shrink-0 size-5 text-primary animate-spin" />
    </template>
  </UContextMenu>
</template>
```

> [!TIP]
> See: #slots
> 
> You can also use the `#item`, `#item-leading`, `#item-label` and `#item-trailing` slots to customize all items.

### Extract shortcuts

Use the [extractShortcuts](https://ui.nuxt.com/docs/composables/extract-shortcuts) utility to automatically define shortcuts from menu items with a `kbds` property. It recursively extracts shortcuts and returns an object compatible with [defineShortcuts](https://ui.nuxt.com/docs/composables/define-shortcuts).

```vue
<script setup lang="ts">
const items = [
  [{
    label: 'Show Sidebar',
    kbds: ['meta', 'S'],
    onSelect() {
      console.log('Show Sidebar clicked')
    }
  }, {
    label: 'Show Toolbar',
    kbds: ['shift', 'meta', 'D'],
    onSelect() {
      console.log('Show Toolbar clicked')
    }
  }, {
    label: 'Collapse Pinned Tabs',
    disabled: true
  }], [{
    label: 'Refresh the Page'
  }, {
    label: 'Clear Cookies and Refresh'
  }, {
    label: 'Clear Cache and Refresh'
  }, {
    type: 'separator' as const
  }, {
    label: 'Developer',
    children: [[{
      label: 'View Source',
      kbds: ['option', 'meta', 'U'],
      onSelect() {
        console.log('View Source clicked')
      }
    }, {
      label: 'Developer Tools',
      kbds: ['option', 'meta', 'I'],
      onSelect() {
        console.log('Developer Tools clicked')
      }
    }], [{
      label: 'Inspect Elements',
      kbds: ['option', 'meta', 'C'],
      onSelect() {
        console.log('Inspect Elements clicked')
      }
    }], [{
      label: 'JavaScript Console',
      kbds: ['option', 'meta', 'J'],
      onSelect() {
        console.log('JavaScript Console clicked')
      }
    }]]
  }]
]

defineShortcuts(extractShortcuts(items))
</script>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
