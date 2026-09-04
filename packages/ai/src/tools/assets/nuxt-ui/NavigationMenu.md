# UNavigationMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the NavigationMenu component
 */
interface NavigationMenuProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Determines whether a "single" or "multiple" items can be selected at a time.
   * 
   * Only works when `orientation` is `vertical`.
   * @default 'multiple'
   */
  type?: K | undefined;
  /**
   * The controlled value of the active item(s).
   * - In horizontal orientation: always `string`
   * - In vertical orientation with `type="single"`: `string`
   * - In vertical orientation with `type="multiple"`: `string[]`
   * 
   * Use this when you need to control the state of the items. Can be binded with `v-model`
   */
  modelValue?: NavigationMenuModelValue<K, O> | undefined;
  /**
   * The default active value of the item(s).
   * - In horizontal orientation: always `string`
   * - In vertical orientation with `type="single"`: `string`
   * - In vertical orientation with `type="multiple"`: `string[]`
   * 
   * Use when you do not need to control the state of the item(s).
   */
  defaultValue?: NavigationMenuModelValue<K, O> | undefined;
  /**
   * The icon displayed to open the menu.
   * @default appConfig.ui.icons.chevronDown
   */
  trailingIcon?: any;
  /**
   * The icon displayed when the item is an external link.
   * Set to `false` to hide the external icon.
   * @default true
   */
  externalIcon?: any;
  items?: T | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'pill'
   */
  variant?: "pill" | "link" | undefined;
  /**
   * The orientation of the menu.
   * @default 'horizontal'
   */
  orientation?: O | undefined;
  /**
   * Collapse the navigation menu to only show icons.
   * Only works when `orientation` is `vertical`.
   * @default false
   */
  collapsed?: boolean | undefined;
  /**
   * Display a tooltip on the items with the label of the item.
   * Only works when `orientation` is `vertical` and `collapsed` is `true`.
   * `{ delayDuration: 0, content: { side: 'right' } }`{lang="ts-type"}
   * @default false
   */
  tooltip?: boolean | TooltipProps | undefined;
  /**
   * Display a popover on the items when the menu is collapsed with the children list.
   * `{ mode: 'hover', content: { side: 'right', align: 'start', alignOffset: 2 } }`{lang="ts-type"}
   * @default false
   */
  popover?: boolean | PopoverProps<PopoverMode> | undefined;
  /**
   * Display a line next to the active item.
   */
  highlight?: boolean | undefined;
  /**
   * @default 'primary'
   */
  highlightColor?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * The content of the menu.
   */
  content?: Omit<NavigationMenuContentProps, "as" | "asChild" | "forceMount"> & Partial<EmitsToProps<DismissableLayerEmits>> | undefined;
  /**
   * The orientation of the content.
   * Only works when `orientation` is `horizontal`.
   * @default 'horizontal'
   */
  contentOrientation?: "horizontal" | "vertical" | undefined;
  /**
   * Display an arrow alongside the menu.
   * @default false
   */
  arrow?: boolean | undefined;
  /**
   * The key used to get the value from the item.
   * @default 'value'
   */
  valueKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  ui?: { root?: SlotClass; list?: SlotClass; label?: SlotClass; item?: SlotClass; link?: SlotClass; linkLeadingIcon?: SlotClass; linkLeadingAvatar?: SlotClass; linkLeadingAvatarSize?: SlotClass; linkLeadingChipSize?: SlotClass; linkTrailing?: SlotClass; linkTrailingBadge?: SlotClass; linkTrailingBadgeSize?: SlotClass; linkTrailingIcon?: SlotClass; linkLabel?: SlotClass; linkLabelExternalIcon?: SlotClass; childList?: SlotClass; childLabel?: SlotClass; childItem?: SlotClass; childLink?: SlotClass; childLinkWrapper?: SlotClass; childLinkIcon?: SlotClass; childLinkLabel?: SlotClass; childLinkLabelExternalIcon?: SlotClass; childLinkDescription?: SlotClass; separator?: SlotClass; viewportWrapper?: SlotClass; viewport?: SlotClass; content?: SlotClass; indicator?: SlotClass; arrow?: SlotClass; } | undefined;
  /**
   * The duration from when the pointer enters the trigger until the tooltip gets opened.
   * @default 0
   */
  delayDuration?: number | undefined;
  /**
   * If `true`, menu cannot be open by click on trigger
   * @default false
   */
  disableClickTrigger?: boolean | undefined;
  /**
   * If `true`, menu cannot be open by hover on trigger
   * @default false
   */
  disableHoverTrigger?: boolean | undefined;
  /**
   * How much time a user has to enter another trigger without incurring a delay again.
   * @default 300
   */
  skipDelayDuration?: number | undefined;
  /**
   * If `true`, menu will not close during pointer leave event
   * @default false
   */
  disablePointerLeaveClose?: boolean | undefined;
  /**
   * When `true`, the element will be unmounted on closed state.
   * @default true
   */
  unmountOnHide?: boolean | undefined;
  /**
   * When `true`, prevents the user from interacting with the accordion and all its items
   * @default false
   */
  disabled?: boolean | undefined;
  /**
   * When type is "single", allows closing content when clicking trigger for an open item.
   * When type is "multiple", this prop has no effect.
   * @default true
   */
  collapsible?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the NavigationMenu component
 */
interface NavigationMenuSlots {
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-trailing(): any;
  item-content(): any;
  list-leading(): any;
  list-trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the NavigationMenu component
 */
interface NavigationMenuEmits {
  update:modelValue: (payload: [value: NavigationMenuModelValue<K, O> | undefined]) => void;
}
```

## Composition

Parts placed by name: `#item`, `#item-leading`, `#item-label`, `#item-trailing`, `#item-content`, `#list-leading`, `#list-trailing`.

Also written in the docs and absent from the interface above — one per column or item: `#more`, `#github-trailing`, `#personal-label-trailing`, `#teams-label-trailing`, `#docs-content`.

## Usage

Use the NavigationMenu component to display a list of links horizontally or vertically.

```vue
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const items = ref<NavigationMenuItem[]>([
  {
    label: "Guide",
    icon: "i-lucide-book-open",
    to: "/docs/getting-started",
    children: [
      {
        label: "Introduction",
        description: "Fully styled and customizable components for Nuxt.",
        icon: "i-lucide-house"
      },
      {
        label: "Installation",
        description: "Learn how to install and configure Nuxt UI in your application.",
        icon: "i-lucide-cloud-download"
      },
      {
        label: "Icons",
        icon: "i-lucide-smile",
        description: "You have nothing to do, @nuxt/icon will handle it automatically."
      },
      {
        label: "Colors",
        icon: "i-lucide-swatch-book",
        description: "Choose a primary and a neutral color from your Tailwind CSS theme."
      },
      {
        label: "Theme",
        icon: "i-lucide-cog",
        description: "You can customize components by using the `class` / `ui` props or in your app.config.ts."
      }
    ]
  },
  {
    label: "Composables",
    icon: "i-lucide-database",
    to: "/docs/composables",
    children: [
      {
        label: "defineShortcuts",
        icon: "i-lucide-file-text",
        description: "Define shortcuts for your application.",
        to: "/docs/composables/define-shortcuts"
      },
      {
        label: "useOverlay",
        icon: "i-lucide-file-text",
        description: "Display a modal/slideover within your application.",
        to: "/docs/composables/use-overlay"
      },
      {
        label: "useToast",
        icon: "i-lucide-file-text",
        description: "Display a toast within your application.",
        to: "/docs/composables/use-toast"
      }
    ]
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components",
    active: true,
    children: [
      {
        label: "Link",
        icon: "i-lucide-file-text",
        description: "Use NuxtLink with superpowers.",
        to: "/docs/components/link"
      },
      {
        label: "Modal",
        icon: "i-lucide-file-text",
        description: "Display a modal within your application.",
        to: "/docs/components/modal"
      },
      {
        label: "NavigationMenu",
        icon: "i-lucide-file-text",
        description: "Display a list of links.",
        to: "/docs/components/navigation-menu"
      },
      {
        label: "Pagination",
        icon: "i-lucide-file-text",
        description: "Display a list of pages.",
        to: "/docs/components/pagination"
      },
      {
        label: "Popover",
        icon: "i-lucide-file-text",
        description: "Display a non-modal dialog that floats around a trigger element.",
        to: "/docs/components/popover"
      },
      {
        label: "Progress",
        icon: "i-lucide-file-text",
        description: "Show a horizontal bar to indicate task progression.",
        to: "/docs/components/progress"
      }
    ]
  },
  {
    label: "GitHub",
    icon: "i-simple-icons-github",
    badge: "6k",
    to: "https://github.com/nuxt/ui",
    target: "_blank"
  },
  {
    label: "Help",
    icon: "i-lucide-circle-help",
    disabled: true
  }
])
</script>

<template>
  <UNavigationMenu :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`
- `icon?: string`
- `avatar?: AvatarProps`
- `badge?: string | number | BadgeProps`
- [`chip?: boolean | ChipProps`](#with-chip-in-items)
- [`tooltip?: TooltipProps`](#with-tooltip-in-items)
- [`popover?: PopoverProps`](#with-popover-in-items)
- `trailingIcon?: string`
- `type?: 'label' | 'trigger' | 'link'`
- `defaultOpen?: boolean`
- `open?: boolean`
- `value?: string`
- `disabled?: boolean`
- [`slot?: string`](#with-custom-slot)
- `onSelect?: (e: Event) => void`
- `children?: NavigationMenuChildItem[]`
- `class?: any`
- `ui?: { linkLeadingAvatarSize?: ClassNameValue, linkLeadingAvatar?: ClassNameValue, linkLeadingIcon?: ClassNameValue, linkLeadingChipSize?: ClassNameValue, linkLabel?: ClassNameValue, linkLabelExternalIcon?: ClassNameValue, linkTrailing?: ClassNameValue, linkTrailingBadgeSize?: ClassNameValue, linkTrailingBadge?: ClassNameValue, linkTrailingIcon?: ClassNameValue, label?: ClassNameValue, link?: ClassNameValue, content?: ClassNameValue, childList?: ClassNameValue, childLabel?: ClassNameValue, childItem?: ClassNameValue, childLink?: ClassNameValue, childLinkIcon?: ClassNameValue, childLinkWrapper?: ClassNameValue, childLinkLabel?: ClassNameValue, childLinkLabelExternalIcon?: ClassNameValue, childLinkDescription?: ClassNameValue }`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const items = ref<NavigationMenuItem[]>([
  {
    label: "Guide",
    icon: "i-lucide-book-open",
    to: "/docs/getting-started",
    children: [
      {
        label: "Introduction",
        description: "Fully styled and customizable components for Nuxt.",
        icon: "i-lucide-house"
      },
      {
        label: "Installation",
        description: "Learn how to install and configure Nuxt UI in your application.",
        icon: "i-lucide-cloud-download"
      },
      {
        label: "Icons",
        icon: "i-lucide-smile",
        description: "You have nothing to do, @nuxt/icon will handle it automatically."
      },
      {
        label: "Colors",
        icon: "i-lucide-swatch-book",
        description: "Choose a primary and a neutral color from your Tailwind CSS theme."
      },
      {
        label: "Theme",
        icon: "i-lucide-cog",
        description: "You can customize components by using the `class` / `ui` props or in your app.config.ts."
      }
    ]
  },
  {
    label: "Composables",
    icon: "i-lucide-database",
    to: "/docs/composables",
    children: [
      {
        label: "defineShortcuts",
        icon: "i-lucide-file-text",
        description: "Define shortcuts for your application.",
        to: "/docs/composables/define-shortcuts"
      },
      {
        label: "useOverlay",
        icon: "i-lucide-file-text",
        description: "Display a modal/slideover within your application.",
        to: "/docs/composables/use-overlay"
      },
      {
        label: "useToast",
        icon: "i-lucide-file-text",
        description: "Display a toast within your application.",
        to: "/docs/composables/use-toast"
      }
    ]
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components",
    active: true,
    children: [
      {
        label: "Link",
        icon: "i-lucide-file-text",
        description: "Use NuxtLink with superpowers.",
        to: "/docs/components/link"
      },
      {
        label: "Modal",
        icon: "i-lucide-file-text",
        description: "Display a modal within your application.",
        to: "/docs/components/modal"
      },
      {
        label: "NavigationMenu",
        icon: "i-lucide-file-text",
        description: "Display a list of links.",
        to: "/docs/components/navigation-menu"
      },
      {
        label: "Pagination",
        icon: "i-lucide-file-text",
        description: "Display a list of pages.",
        to: "/docs/components/pagination"
      },
      {
        label: "Popover",
        icon: "i-lucide-file-text",
        description: "Display a non-modal dialog that floats around a trigger element.",
        to: "/docs/components/popover"
      },
      {
        label: "Progress",
        icon: "i-lucide-file-text",
        description: "Show a horizontal bar to indicate task progression.",
        to: "/docs/components/progress"
      }
    ]
  },
  {
    label: "GitHub",
    icon: "i-simple-icons-github",
    badge: "6k",
    to: "https://github.com/nuxt/ui",
    target: "_blank"
  },
  {
    label: "Help",
    icon: "i-lucide-circle-help",
    disabled: true
  }
])
</script>

<template>
  <UNavigationMenu :items="items" class="w-full justify-center" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control active item

You can control the active item(s) by using the `default-value` prop or the `v-model` directive with the `value` of the item. If no `value` is provided, it defaults to `item-${index}` for top-level items or `item-${level}-${index}` for nested items.

```vue [NavigationMenuModelValueExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const items: NavigationMenuItem[] = [
  {
    label: 'Guide',
    icon: 'i-lucide-book-open',
    children: [
      {
        label: 'Introduction',
        description: 'Fully styled and customizable components for Nuxt.',
        icon: 'i-lucide-house'
      },
      {
        label: 'Installation',
        description: 'Learn how to install and configure Nuxt UI in your application.',
        icon: 'i-lucide-cloud-download'
      },
      {
        label: 'Icons',
        icon: 'i-lucide-smile',
        description: 'You have nothing to do, @nuxt/icon will handle it automatically.'
      },
      {
        label: 'Colors',
        icon: 'i-lucide-swatch-book',
        description: 'Choose a primary and a neutral color from your Tailwind CSS theme.'
      },
      {
        label: 'Theme',
        icon: 'i-lucide-cog',
        description: 'You can customize components by using the `class` / `ui` props or in your app.config.ts.'
      }
    ]
  },
  {
    label: 'Composables',
    icon: 'i-lucide-database',
    children: [
      {
        label: 'defineShortcuts',
        icon: 'i-lucide-file-text',
        description: 'Define shortcuts for your application.'
      },
      {
        label: 'useOverlay',
        icon: 'i-lucide-file-text',
        description: 'Display a modal/slideover within your application.'
      },
      {
        label: 'useToast',
        icon: 'i-lucide-file-text',
        description: 'Display a toast within your application.'
      }
    ]
  },
  {
    label: 'Components',
    icon: 'i-lucide-box',
    children: [
      {
        label: 'Link',
        icon: 'i-lucide-file-text',
        description: 'Use NuxtLink with superpowers.'
      },
      {
        label: 'Modal',
        icon: 'i-lucide-file-text',
        description: 'Display a modal within your application.'
      },
      {
        label: 'NavigationMenu',
        icon: 'i-lucide-file-text',
        description: 'Display a list of links.'
      },
      {
        label: 'Pagination',
        icon: 'i-lucide-file-text',
        description: 'Display a list of pages.'
      },
      {
        label: 'Popover',
        icon: 'i-lucide-file-text',
        description: 'Display a non-modal dialog that floats around a trigger element.'
      },
      {
        label: 'Progress',
        icon: 'i-lucide-file-text',
        description: 'Show a horizontal bar to indicate task progression.'
      }
    ]
  }
]

const active = ref()

defineShortcuts({
  1: () => {
    active.value = 'item-0'
  },
  2: () => {
    active.value = 'item-1'
  },
  3: () => {
    active.value = 'item-2'
  }
})
</script>

<template>
  <UNavigationMenu v-model="active" :items="items" class="w-full justify-center" />
</template>
```

> [!TIP]
> 
> Use the `value-key` prop to change the key used to match items when a `v-model` or `default-value` is provided.

> [!NOTE]
> 
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can switch the active item by pressing `1`, `2`, or `3`.

### With tooltip in items

When orientation is `vertical` and the menu is `collapsed`, you can set the `tooltip` prop to `true` to display a [Tooltip](https://ui.nuxt.com/docs/components/tooltip) around items with their label but you can also use the `tooltip` property on each item to override the default tooltip. In `horizontal` orientation, you can use the `tooltip` property on each item to display a [Tooltip](https://ui.nuxt.com/docs/components/tooltip) around items.

> [!NOTE]
> 
> The `tooltip` property on an item will always display a tooltip regardless of the global `tooltip` prop.

You can pass any property from the [Tooltip](https://ui.nuxt.com/docs/components/tooltip) component globally or on each item.

```vue
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const items = ref<NavigationMenuItem[][]>([
  [
    {
      label: "Links",
      type: "label"
    },
    {
      label: "Guide",
      icon: "i-lucide-book-open",
      children: [
        {
          label: "Introduction",
          description: "Fully styled and customizable components for Nuxt.",
          icon: "i-lucide-house"
        },
        {
          label: "Installation",
          description: "Learn how to install and configure Nuxt UI in your application.",
          icon: "i-lucide-cloud-download"
        },
        {
          label: "Icons",
          icon: "i-lucide-smile",
          description: "You have nothing to do, @nuxt/icon will handle it automatically."
        },
        {
          label: "Colors",
          icon: "i-lucide-swatch-book",
          description: "Choose a primary and a neutral color from your Tailwind CSS theme."
        },
        {
          label: "Theme",
          icon: "i-lucide-cog",
          description: "You can customize components by using the `class` / `ui` props or in your app.config.ts."
        }
      ]
    },
    {
      label: "Composables",
      icon: "i-lucide-database",
      children: [
        {
          label: "defineShortcuts",
          icon: "i-lucide-file-text",
          description: "Define shortcuts for your application.",
          to: "/docs/composables/define-shortcuts"
        },
        {
          label: "useOverlay",
          icon: "i-lucide-file-text",
          description: "Display a modal/slideover within your application.",
          to: "/docs/composables/use-overlay"
        },
        {
          label: "useToast",
          icon: "i-lucide-file-text",
          description: "Display a toast within your application.",
          to: "/docs/composables/use-toast"
        }
      ]
    },
    {
      label: "Components",
      icon: "i-lucide-box",
      to: "/docs/components",
      active: true,
      children: [
        {
          label: "Link",
          icon: "i-lucide-file-text",
          description: "Use NuxtLink with superpowers.",
          to: "/docs/components/link"
        },
        {
          label: "Modal",
          icon: "i-lucide-file-text",
          description: "Display a modal within your application.",
          to: "/docs/components/modal"
        },
        {
          label: "NavigationMenu",
          icon: "i-lucide-file-text",
          description: "Display a list of links.",
          to: "/docs/components/navigation-menu"
        },
        {
          label: "Pagination",
          icon: "i-lucide-file-text",
          description: "Display a list of pages.",
          to: "/docs/components/pagination"
        },
        {
          label: "Popover",
          icon: "i-lucide-file-text",
          description: "Display a non-modal dialog that floats around a trigger element.",
          to: "/docs/components/popover"
        },
        {
          label: "Progress",
          icon: "i-lucide-file-text",
          description: "Show a horizontal bar to indicate task progression.",
          to: "/docs/components/progress"
        }
      ]
    }
  ],
  [
    {
      label: "GitHub",
      icon: "i-simple-icons-github",
      badge: "6k",
      to: "https://github.com/nuxt/ui",
      target: "_blank",
      tooltip: {
        text: "Open on GitHub",
        kbds: [
          "6k"
        ]
      }
    },
    {
      label: "Help",
      icon: "i-lucide-circle-help",
      disabled: true
    }
  ]
])
</script>

<template>
  <UNavigationMenu tooltip collapsed orientation="vertical" :items="items" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
