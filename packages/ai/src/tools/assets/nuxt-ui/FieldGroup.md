# UFieldGroup

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the FieldGroup component
 */
interface FieldGroupProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * The orientation the buttons are laid out.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  ui?: { base?: any; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the FieldGroup component
 */
interface FieldGroupSlots {
  default(): any;
}
```

## Usage

Wrap multiple [Button](https://ui.nuxt.com/docs/components/button) within a FieldGroup to group them together.

```vue
<template>
  <UFieldGroup>
    <UButton color="neutral" variant="subtle" label="Button" />
    <UButton color="neutral" variant="outline" icon="i-lucide-chevron-down" />
  </UFieldGroup>
</template>
```

### Size

Use the `size` prop to change the size of all the buttons.

```vue
<template>
  <UFieldGroup size="xl">
    <UButton color="neutral" variant="subtle" label="Button" />
    <UButton color="neutral" variant="outline" icon="i-lucide-chevron-down" />
  </UFieldGroup>
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the buttons. Defaults to `horizontal`.

```vue
<template>
  <UFieldGroup orientation="vertical">
    <UButton color="neutral" variant="subtle" label="Submit" />
    <UButton color="neutral" variant="outline" label="Cancel" />
  </UFieldGroup>
</template>
```

## Examples

### With input

You can use components like [Input](https://ui.nuxt.com/docs/components/input), [InputMenu](https://ui.nuxt.com/docs/components/input-menu), [Select](https://ui.nuxt.com/docs/components/select) [SelectMenu](https://ui.nuxt.com/docs/components/select-menu), etc. within a field group.

```vue
<template>
  <UFieldGroup>
    <UInput color="neutral" variant="outline" placeholder="Enter token" />

    <UButton color="neutral" variant="subtle" icon="i-lucide-clipboard" />
  </UFieldGroup>
</template>
```

### With tooltip

You can use a [Tooltip](https://ui.nuxt.com/docs/components/tooltip) within a field group.

```vue [FieldGroupTooltipExample.vue]
<template>
  <UFieldGroup>
    <UInput color="neutral" variant="outline" placeholder="Enter token" />

    <UTooltip text="Copy to clipboard">
      <UButton
        color="neutral"
        variant="subtle"
        icon="i-lucide-clipboard"
      />
    </UTooltip>
  </UFieldGroup>
</template>
```

### With dropdown menu

You can use a [DropdownMenu](https://ui.nuxt.com/docs/components/dropdown-menu) within a field group.

```vue [FieldGroupDropdownExample.vue]
<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const items: DropdownMenuItem[] = [
  {
    label: 'Team',
    icon: 'i-lucide-users'
  },
  {
    label: 'Invite users',
    icon: 'i-lucide-user-plus',
    children: [
      {
        label: 'Invite by email',
        icon: 'i-lucide-send-horizontal'
      },
      {
        label: 'Invite by link',
        icon: 'i-lucide-link'
      }
    ]
  },
  {
    label: 'New team',
    icon: 'i-lucide-plus'
  }
]
</script>

<template>
  <UFieldGroup>
    <UButton color="neutral" variant="subtle" label="Settings" />

    <UDropdownMenu :items="items">
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-chevron-down"
      />
    </UDropdownMenu>
  </UFieldGroup>
</template>
```

### With badge

You can use a [Badge](https://ui.nuxt.com/docs/components/badge) within a field group.

```vue [FieldGroupBadgeExample.vue]
<template>
  <UFieldGroup>
    <UBadge color="neutral" variant="outline" size="lg" label="https://" />

    <UInput color="neutral" variant="outline" placeholder="www.example.com" />
  </UFieldGroup>
</template>
```
