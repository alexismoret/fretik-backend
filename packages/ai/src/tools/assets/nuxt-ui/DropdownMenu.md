# UDropdownMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the DropdownMenu component
 */
interface DropdownMenuProps {
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
   * @default { side: 'bottom', sideOffset: 8, collisionPadding: 8 }
   */
  content?:
    | (Omit<DropdownMenuContentProps, "as" | "asChild" | "forceMount"> &
        Partial<EmitsToProps<MenuContentEmits>>)
    | undefined;
  /**
   * Display an arrow alongside the menu.
   * `{ rounded: true }`{lang="ts-type"}
   * @default false
   */
  arrow?: boolean | Omit<DropdownMenuArrowProps, "as" | "asChild"> | undefined;
  /**
   * Render the menu in a portal.
   * @default true
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  /**
   * The key used to get the description from the item.
   * @default 'description'
   */
  descriptionKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  /**
   * Whether to display a filter input or not.
   * Can be an object to pass additional props to the input.
   * `{ placeholder: 'Search...', variant: 'none' }`{lang="ts-type"}
   * @default false
   */
  filter?:
    | boolean
    | Omit<
        InputProps<AcceptableValue, ModelModifiers>,
        "modelValue" | "defaultValue"
      >
    | undefined;
  /**
   * The fields to filter by.
   * @default [labelKey]
   */
  filterFields?: string[] | undefined;
  /**
   * When `true`, items will not be filtered which is useful for custom filtering.
   * @default false
   */
  ignoreFilter?: boolean | undefined;
  disabled?: boolean | undefined;
  ui?:
    | {
        content?: SlotClass;
        input?: SlotClass;
        empty?: SlotClass;
        viewport?: SlotClass;
        arrow?: SlotClass;
        group?: SlotClass;
        label?: SlotClass;
        separator?: SlotClass;
        item?: SlotClass;
        itemLeadingIcon?: SlotClass;
        itemLeadingAvatar?: SlotClass;
        itemLeadingAvatarSize?: SlotClass;
        itemTrailing?: SlotClass;
        itemTrailingIcon?: SlotClass;
        itemTrailingKbds?: SlotClass;
        itemTrailingKbdsSize?: SlotClass;
        itemWrapper?: SlotClass;
        itemLabel?: SlotClass;
        itemDescription?: SlotClass;
        itemLabelExternalIcon?: SlotClass;
      }
    | undefined;
  /**
   * The open state of the dropdown menu when it is initially rendered. Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * The controlled open state of the menu. Can be used as `v-model:open`.
   */
  open?: boolean | undefined;
  /**
   * The modality of the dropdown menu.
   *
   * When set to `true`, interaction with outside elements will be disabled and only menu content will be visible to screen readers.
   * @default true
   */
  modal?: boolean | undefined;
  /**
   * @default ''
   */
  searchTerm?: string | undefined;
}
```

### Slots

```ts
/**
 * Slots for the DropdownMenu component
 */
interface DropdownMenuSlots {
  default(): any;
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-description(): any;
  item-trailing(): any;
  empty(): any;
  content-top(): any;
  content-bottom(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the DropdownMenu component
 */
interface DropdownMenuEmits {
  update:open: (payload: [payload: boolean]) => void;
  update:searchTerm: (payload: [value: string]) => void;
}
```

## Usage

Use a [Button](https://ui.nuxt.com/docs/components/button) or any other component in the default slot of the DropdownMenu.

```vue
<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";

const items = ref<DropdownMenuItem[][]>([
  [
    {
      label: "Benjamin",
      avatar: {
        src: "https://github.com/benjamincanac.png",
        loading: "lazy",
      },
      type: "label",
    },
  ],
  [
    {
      label: "Profile",
      icon: "i-lucide-user",
    },
    {
      label: "Billing",
      icon: "i-lucide-credit-card",
    },
    {
      label: "Settings",
      icon: "i-lucide-cog",
      kbds: [","],
    },
    {
      label: "Keyboard shortcuts",
      icon: "i-lucide-monitor",
    },
  ],
  [
    {
      label: "Team",
      icon: "i-lucide-users",
      filter: {
        placeholder: "Search members...",
      },
      children: [
        [
          {
            label: "benjamincanac",
            avatar: {
              src: "https://github.com/benjamincanac.png",
              loading: "lazy",
            },
          },
          {
            label: "HugoRCD",
            avatar: {
              src: "https://github.com/HugoRCD.png",
              loading: "lazy",
            },
          },
          {
            label: "romhml",
            avatar: {
              src: "https://github.com/romhml.png",
              loading: "lazy",
            },
          },
          {
            label: "sandros94",
            avatar: {
              src: "https://github.com/sandros94.png",
              loading: "lazy",
            },
          },
          {
            label: "hywax",
            avatar: {
              src: "https://github.com/hywax.png",
              loading: "lazy",
            },
          },
          {
            label: "J-Michalek",
            avatar: {
              src: "https://github.com/J-Michalek.png",
              loading: "lazy",
            },
          },
          {
            label: "genu",
            avatar: {
              src: "https://github.com/genu.png",
              loading: "lazy",
            },
          },
        ],
      ],
    },
    {
      label: "Invite users",
      icon: "i-lucide-user-plus",
      children: [
        [
          {
            label: "Email",
            icon: "i-lucide-mail",
          },
          {
            label: "Message",
            icon: "i-lucide-message-square",
          },
        ],
        [
          {
            label: "More",
            icon: "i-lucide-circle-plus",
            children: [
              {
                label: "Import from Slack",
                icon: "i-simple-icons-slack",
                to: "https://slack.com",
                target: "_blank",
              },
              {
                label: "Import from Trello",
                icon: "i-simple-icons-trello",
              },
              {
                label: "Import from Asana",
                icon: "i-simple-icons-asana",
              },
            ],
          },
        ],
      ],
    },
    {
      label: "New team",
      icon: "i-lucide-plus",
      kbds: ["meta", "n"],
    },
  ],
  [
    {
      label: "GitHub",
      icon: "i-simple-icons-github",
      to: "https://github.com/nuxt/ui",
      target: "_blank",
    },
    {
      label: "Support",
      icon: "i-lucide-life-buoy",
      to: "/docs/components/dropdown-menu",
    },
    {
      label: "API",
      icon: "i-lucide-cloud",
      disabled: true,
    },
  ],
  [
    {
      label: "Logout",
      icon: "i-lucide-log-out",
      color: "error",
      kbds: ["shift", "meta", "q"],
    },
  ],
]);
</script>

<template>
  <UDropdownMenu :items="items">
    <UButton icon="i-lucide-menu" color="neutral" variant="outline" />
  </UDropdownMenu>
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `avatar?: AvatarProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `kbds?: string[] | KbdProps[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`type?: "link" | "label" | "separator" | "checkbox"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-checkbox-items)
- [`color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-color-items)
- [`checked?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-checkbox-items)
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-custom-slot)
- `onSelect?: (e: Event) => void`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`onUpdateChecked?: (checked: boolean) => void`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-checkbox-items)
- `children?: DropdownMenuItem[] | DropdownMenuItem[][]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`filter?: boolean | InputProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-filter-items)
- `filterFields?: string[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ignoreFilter?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, label?: ClassNameValue, separator?: ClassNameValue, itemLeadingIcon?: ClassNameValue, itemLeadingAvatarSize?: ClassNameValue, itemLeadingAvatar?: ClassNameValue, itemLabel?: ClassNameValue, itemLabelExternalIcon?: ClassNameValue, itemTrailing?: ClassNameValue, itemTrailingIcon?: ClassNameValue, itemTrailingKbds?: ClassNameValue, itemTrailingKbdsSize?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";

const items = ref<DropdownMenuItem[][]>([
  [
    {
      label: "Benjamin",
      avatar: {
        src: "https://github.com/benjamincanac.png",
        loading: "lazy",
      },
      type: "label",
    },
  ],
  [
    {
      label: "Profile",
      icon: "i-lucide-user",
    },
    {
      label: "Billing",
      icon: "i-lucide-credit-card",
    },
    {
      label: "Settings",
      icon: "i-lucide-cog",
      kbds: [","],
    },
    {
      label: "Keyboard shortcuts",
      icon: "i-lucide-monitor",
    },
  ],
  [
    {
      label: "Team",
      icon: "i-lucide-users",
    },
    {
      label: "Invite users",
      icon: "i-lucide-user-plus",
      children: [
        [
          {
            label: "Email",
            icon: "i-lucide-mail",
          },
          {
            label: "Message",
            icon: "i-lucide-message-square",
          },
        ],
        [
          {
            label: "More",
            icon: "i-lucide-circle-plus",
            children: [
              {
                label: "Import from Slack",
                icon: "i-simple-icons-slack",
                to: "https://slack.com",
                target: "_blank",
              },
              {
                label: "Import from Trello",
                icon: "i-simple-icons-trello",
              },
              {
                label: "Import from Asana",
                icon: "i-simple-icons-asana",
              },
            ],
          },
        ],
      ],
    },
    {
      label: "New team",
      icon: "i-lucide-plus",
      kbds: ["meta", "n"],
    },
  ],
  [
    {
      label: "GitHub",
      icon: "i-simple-icons-github",
      to: "https://github.com/nuxt/ui",
      target: "_blank",
    },
    {
      label: "Support",
      icon: "i-lucide-life-buoy",
      to: "/docs/components/dropdown-menu",
    },
    {
      label: "API",
      icon: "i-lucide-cloud",
      disabled: true,
    },
  ],
  [
    {
      label: "Logout",
      icon: "i-lucide-log-out",
      kbds: ["shift", "meta", "q"],
    },
  ],
]);
</script>

<template>
  <UDropdownMenu
    :items="items"
    :ui="{
      content: 'w-48',
    }"
  >
    <UButton icon="i-lucide-menu" color="neutral" variant="outline" />
  </UDropdownMenu>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With checkbox items

You can use the `type` property with `checkbox` and use the `checked` / `onUpdateChecked` properties to control the checked state of the item.

```vue [DropdownMenuCheckboxItemsExample.vue]
<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";

const showBookmarks = ref(true);
const showHistory = ref(false);
const showDownloads = ref(false);

const items = computed(
  () =>
    [
      {
        label: "Interface",
        icon: "i-lucide-app-window",
        type: "label" as const,
      },
      {
        type: "separator" as const,
      },
      {
        label: "Show Bookmarks",
        icon: "i-lucide-bookmark",
        type: "checkbox" as const,
        checked: showBookmarks.value,
        onUpdateChecked(checked: boolean) {
          showBookmarks.value = checked;
        },
        onSelect(e: Event) {
          e.preventDefault();
        },
      },
      {
        label: "Show History",
        icon: "i-lucide-clock",
        type: "checkbox" as const,
        checked: showHistory.value,
        onUpdateChecked(checked: boolean) {
          showHistory.value = checked;
        },
      },
      {
        label: "Show Downloads",
        icon: "i-lucide-download",
        type: "checkbox" as const,
        checked: showDownloads.value,
        onUpdateChecked(checked: boolean) {
          showDownloads.value = checked;
        },
      },
    ] satisfies DropdownMenuItem[],
);
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'start' }"
    :ui="{ content: 'w-48' }"
  >
    <UButton
      label="Open"
      color="neutral"
      variant="outline"
      icon="i-lucide-menu"
    />
  </UDropdownMenu>
</template>
```

> \[!NOTE]
>
> To ensure reactivity for the `checked` state of items, it's recommended to wrap your `items` array inside a `computed`.

### With color items

You can use the `color` property to highlight certain items with a color.

```vue [DropdownMenuColorItemsExample.vue]
<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";

const items: DropdownMenuItem[][] = [
  [
    {
      label: "View",
      icon: "i-lucide-eye",
    },
    {
      label: "Copy",
      icon: "i-lucide-copy",
    },
    {
      label: "Edit",
      icon: "i-lucide-pencil",
    },
  ],
  [
    {
      label: "Delete",
      color: "error",
      icon: "i-lucide-trash",
    },
  ],
];
</script>

<template>
  <UDropdownMenu :items="items" :ui="{ content: 'w-48' }">
    <UButton
      label="Open"
      color="neutral"
      variant="outline"
      icon="i-lucide-menu"
    />
  </UDropdownMenu>
</template>
```

### With filter items `4.6+`

You can use the `filter` property on items with `children` to display a filter input inside the sub-menu.

```vue [DropdownMenuFilterItemsExample.vue]
<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";

const items: DropdownMenuItem[][] = [
  [
    {
      label: "Profile",
      icon: "i-lucide-user",
    },
    {
      label: "Billing",
      icon: "i-lucide-credit-card",
    },
    {
      label: "Settings",
      icon: "i-lucide-cog",
    },
  ],
  [
    {
      label: "Team",
      icon: "i-lucide-users",
      filter: {
        placeholder: "Search members...",
      },
      children: [
        {
          label: "benjamincanac",
          avatar: {
            src: "https://github.com/benjamincanac.png",
            loading: "lazy" as const,
          },
        },
        {
          label: "HugoRCD",
          avatar: {
            src: "https://github.com/HugoRCD.png",
            loading: "lazy" as const,
          },
        },
        {
          label: "romhml",
          avatar: {
            src: "https://github.com/romhml.png",
            loading: "lazy" as const,
          },
        },
        {
          label: "sandros94",
          avatar: {
            src: "https://github.com/sandros94.png",
            loading: "lazy" as const,
          },
        },
        {
          label: "hywax",
          avatar: {
            src: "https://github.com/hywax.png",
            loading: "lazy" as const,
          },
        },
        {
          label: "J-Michalek",
          avatar: {
            src: "https://github.com/J-Michalek.png",
            loading: "lazy" as const,
          },
        },
        {
          label: "genu",
          avatar: {
            src: "https://github.com/genu.png",
            loading: "lazy" as const,
          },
        },
      ],
    },
    {
      label: "Invite users",
      icon: "i-lucide-user-plus",
      children: [
        {
          label: "Invite by email",
          icon: "i-lucide-mail",
        },
        {
          label: "Invite by link",
          icon: "i-lucide-link",
        },
        {
          label: "Invite by SMS",
          icon: "i-lucide-message-square",
        },
        {
          label: "Invite by WhatsApp",
          icon: "i-simple-icons-whatsapp",
        },
      ],
    },
    {
      label: "New team",
      icon: "i-lucide-plus",
    },
  ],
];
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'start' }"
    :ui="{ content: 'w-48' }"
  >
    <UButton
      label="Open"
      color="neutral"
      variant="outline"
      icon="i-lucide-menu"
    />
  </UDropdownMenu>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
