# UBreadcrumb

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Breadcrumb component
 */
interface BreadcrumbProps {
  /**
   * The element or component this component should render as.
   * @default 'nav'
   */
  as?: any;
  items?: T[] | undefined;
  /**
   * The icon to use as a separator.
   * @default appConfig.ui.icons.chevronRight
   */
  separatorIcon?: any;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * The key used to get the label from the item.
   * @default 'label'
   */
  labelKey?: keyof Extract<NestedItem<T>, object> & string | DotPathKeys<Extract<NestedItem<T>, object>> | undefined;
  ui?: { root?: SlotClass; list?: SlotClass; item?: SlotClass; link?: SlotClass; linkLeadingIcon?: SlotClass; linkLeadingAvatar?: SlotClass; linkLeadingAvatarSize?: SlotClass; linkLabel?: SlotClass; separator?: SlotClass; separatorIcon?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Breadcrumb component
 */
interface BreadcrumbSlots {
  item(): any;
  item-leading(): any;
  item-label(): any;
  item-trailing(): any;
  separator(): any;
}
```

## Composition

Parts placed by name: `#item`, `#item-leading`, `#item-label`, `#item-trailing`, `#separator`.

Also written in the docs and absent from the interface above — one per column or item: `#dropdown`.

```vue
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items: BreadcrumbItem[] = [
  {
    label: 'Docs',
    to: '/docs'
  },
  {
    label: 'Components',
    to: '/docs/components'
  },
  {
    label: 'Breadcrumb',
    to: '/docs/components/breadcrumb'
  }
]
</script>

<template>
  <UBreadcrumb :items="items">
    <template #separator>
      <span class="mx-2 text-muted">/</span>
    </template>
  </UBreadcrumb>
</template>
```

## Usage

Use the Breadcrumb component to show the current page's location in your site's hierarchy.

```vue
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items = ref<BreadcrumbItem[]>([
  {
    label: "Docs",
    icon: "i-lucide-book-open",
    to: "/docs"
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components"
  },
  {
    label: "Breadcrumb",
    icon: "i-lucide-link",
    to: "/docs/components/breadcrumb"
  }
])
</script>

<template>
  <UBreadcrumb :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`
- `icon?: string`
- `avatar?: AvatarProps`
- [`slot?: string`](#with-custom-slot)
- `class?: any`
- `ui?: { item?: ClassNameValue, link?: ClassNameValue, linkLeadingIcon?: ClassNameValue, linkLeadingAvatar?: ClassNameValue, linkLabel?: ClassNameValue, separator?: ClassNameValue, separatorIcon?: ClassNameValue }`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items = ref<BreadcrumbItem[]>([
  {
    label: "Docs",
    icon: "i-lucide-book-open",
    to: "/docs"
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components"
  },
  {
    label: "Breadcrumb",
    icon: "i-lucide-link",
    to: "/docs/components/breadcrumb"
  }
])
</script>

<template>
  <UBreadcrumb :items="items" />
</template>
```

> [!NOTE]
> 
> A `span` is rendered instead of a link when the `to` property is not defined.

### Separator Icon

Use the `separator-icon` prop to customize the [Icon](https://ui.nuxt.com/docs/components/icon) between each item. Defaults to `i-lucide-chevron-right`.

```vue
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items = ref<BreadcrumbItem[]>([
  {
    label: "Docs",
    icon: "i-lucide-book-open",
    to: "/docs"
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components"
  },
  {
    label: "Breadcrumb",
    icon: "i-lucide-link",
    to: "/docs/components/breadcrumb"
  }
])
</script>

<template>
  <UBreadcrumb separator-icon="i-lucide-arrow-right" :items="items" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.chevronRight` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.chevronRight` key.

### Color `4.8+`

Use the `color` prop to change the color of the active Breadcrumb.

```vue
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items = ref<BreadcrumbItem[]>([
  {
    label: "Docs",
    icon: "i-lucide-book-open",
    to: "/docs"
  },
  {
    label: "Components",
    icon: "i-lucide-box",
    to: "/docs/components"
  },
  {
    label: "Breadcrumb",
    icon: "i-lucide-link",
    to: "/docs/components/breadcrumb"
  }
])
</script>

<template>
  <UBreadcrumb color="secondary" :items="items" />
</template>
```

## Examples

### With separator slot

Use the `#separator` slot to customize the separator between each item.

```vue [BreadcrumbSeparatorSlotExample.vue]
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items: BreadcrumbItem[] = [
  {
    label: 'Docs',
    to: '/docs'
  },
  {
    label: 'Components',
    to: '/docs/components'
  },
  {
    label: 'Breadcrumb',
    to: '/docs/components/breadcrumb'
  }
]
</script>

<template>
  <UBreadcrumb :items="items">
    <template #separator>
      <span class="mx-2 text-muted">/</span>
    </template>
  </UBreadcrumb>
</template>
```

### With custom slot

Use the `slot` property to customize a specific item.

You will have access to the following slots:

- `#{{ item.slot }}`
- `#{{ item.slot }}-leading`
- `#{{ item.slot }}-label`
- `#{{ item.slot }}-trailing`

```vue [BreadcrumbCustomSlotExample.vue]
<script setup lang="ts">
import type { BreadcrumbItem } from '@nuxt/ui'

const items = [
  {
    label: 'Home',
    to: '/'
  },
  {
    slot: 'dropdown' as const,
    icon: 'i-lucide-ellipsis',
    children: [
      {
        label: 'Documentation',
        to: '/docs'
      },
      {
        label: 'Themes'
      },
      {
        label: 'GitHub'
      }
    ]
  },
  {
    label: 'Components',
    to: '/docs/components'
  },
  {
    label: 'Breadcrumb',
    to: '/docs/components/breadcrumb'
  }
] satisfies BreadcrumbItem[]
</script>

<template>
  <UBreadcrumb :items="items">
    <template #dropdown="{ item }">
      <UDropdownMenu :items="item.children">
        <UButton :icon="item.icon" color="neutral" variant="link" class="p-0.5" />
      </UDropdownMenu>
    </template>
  </UBreadcrumb>
</template>
```

> [!TIP]
> See: #slots
> 
> You can also use the `#item`, `#item-leading`, `#item-label` and `#item-trailing` slots to customize all items.
