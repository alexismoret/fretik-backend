# UEmpty

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Empty component
 */
interface EmptyProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The icon displayed above the title.
   */
  icon?: any;
  avatar?: AvatarProps | undefined;
  /**
   * When `true`, the loading icon will be displayed.
   */
  loading?: boolean | undefined;
  /**
   * The icon when the `loading` prop is `true`.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Display a list of Button in the body.
   */
  actions?: ButtonProps[] | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "solid" | "soft" | "subtle" | "naked" | undefined;
  /**
   * @default 'md'
   */
  size?: "md" | "xs" | "sm" | "lg" | "xl" | undefined;
  ui?: { root?: SlotClass; header?: SlotClass; avatar?: SlotClass; title?: SlotClass; description?: SlotClass; body?: SlotClass; actions?: SlotClass; footer?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Empty component
 */
interface EmptySlots {
  header(): any;
  leading(): any;
  title(): any;
  description(): any;
  body(): any;
  actions(): any;
  footer(): any;
}
```

## Composition

Parts placed by name: `#body`, `#actions`.

## Usage

Use the Empty component to display a placeholder state when there is no content to show.

```vue
<template>
  <u-empty :actions="[
    {
      icon: 'i-lucide-plus',
      label: 'Create new'
    },
    {
      icon: 'i-lucide-refresh-cw',
      label: 'Refresh',
      color: 'neutral',
      variant: 'subtle'
    }
  ]" description="It looks like you haven't added any projects. Create one to get started." icon="i-lucide-file" title="No projects found" />
</template>
```

### Title

Use the `title` prop to set the title of the empty state.

```vue
<template>
  <UEmpty title="No projects found" />
</template>
```

### Description

Use the `description` prop to set the description of the empty state.

```vue
<template>
  <UEmpty title="No projects found" description="It looks like you haven't added any projects. Create one to get started." />
</template>
```

### Icon

Use the `icon` prop to set the icon of the empty state.

```vue
<template>
  <UEmpty icon="i-lucide-file" title="No projects found" description="It looks like you haven't added any projects. Create one to get started." />
</template>
```

### Avatar

Use the `avatar` prop to set the avatar of the empty state.

```vue
<template>
  <UEmpty :avatar="{
  src: 'https://github.com/nuxt.png'
}" title="No projects found" description="It looks like you haven't added any projects. Create one to get started." />
</template>
```

### Loading `4.10+`

Use the `loading` prop to show a loading icon in place of the icon. The layout stays identical, so you can toggle between loading and empty states without layout shifts.

```vue
<template>
  <UEmpty icon="i-lucide-file" loading title="Loading projects" description="Please wait while we fetch your projects." />
</template>
```

### Loading Icon `4.10+`

Use the `loading-icon` prop to customize the loading icon. Defaults to `i-lucide-loader-circle`.

```vue
<template>
  <UEmpty icon="i-lucide-file" loading loading-icon="i-lucide-loader" title="Loading projects" description="Please wait while we fetch your projects." />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.loading` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.loading` key.

### Actions

Use the `actions` prop to add some [Button](https://ui.nuxt.com/docs/components/button) actions to the empty state.

```vue
<template>
  <UEmpty icon="i-lucide-file" title="No projects found" description="It looks like you haven't added any projects. Create one to get started." :actions="[
  {
    icon: 'i-lucide-plus',
    label: 'Create new'
  },
  {
    icon: 'i-lucide-refresh-cw',
    label: 'Refresh',
    color: 'neutral',
    variant: 'subtle'
  }
]" />
</template>
```

### Variant

Use the `variant` prop to change the variant of the empty state.

```vue
<template>
  <UEmpty variant="naked" icon="i-lucide-bell" title="No notifications" description="You're all caught up. New notifications will appear here." :actions="[
  {
    icon: 'i-lucide-refresh-cw',
    label: 'Refresh',
    color: 'neutral',
    variant: 'subtle'
  }
]" />
</template>
```

### Size

Use the `size` prop to change the size of the empty state.

```vue
<template>
  <UEmpty size="xl" icon="i-lucide-bell" title="No notifications" description="You're all caught up. New notifications will appear here." :actions="[
  {
    icon: 'i-lucide-refresh-cw',
    label: 'Refresh',
    color: 'neutral',
    variant: 'subtle'
  }
]" />
</template>
```

## Examples

### With slots

Use the available slots to create a more complex empty state.

```vue [EmptySlotsExample.vue]
<script setup lang="ts">
import type { UserProps } from '@nuxt/ui'

const members: UserProps[] = [
  {
    name: 'Daniel Roe',
    description: 'danielroe',
    to: 'https://github.com/danielroe',
    target: '_blank',
    avatar: {
      src: 'https://github.com/danielroe.png',
      alt: 'danielroe',
      loading: 'lazy' as const
    }
  },
  {
    name: 'Pooya Parsa',
    description: 'pi0',
    to: 'https://github.com/pi0',
    target: '_blank',
    avatar: {
      src: 'https://github.com/pi0.png',
      alt: 'pi0',
      loading: 'lazy' as const
    }
  },
  {
    name: 'Sébastien Chopin',
    description: 'atinux',
    to: 'https://github.com/atinux',
    target: '_blank',
    avatar: {
      src: 'https://github.com/atinux.png',
      alt: 'atinux',
      loading: 'lazy' as const
    }
  },
  {
    name: 'Benjamin Canac',
    description: 'benjamincanac',
    to: 'https://github.com/benjamincanac',
    target: '_blank',
    avatar: {
      src: 'https://github.com/benjamincanac.png',
      alt: 'benjamincanac',
      loading: 'lazy' as const
    }
  }
]
</script>

<template>
  <UEmpty
    title="No team members"
    description="Invite your team to collaborate on this project."
    variant="naked"
    :actions="[{
      label: 'Invite members',
      icon: 'i-lucide-user-plus',
      color: 'neutral'
    }]"
  >
    <template #leading>
      <UAvatarGroup size="xl">
        <UAvatar src="https://github.com/nuxt.png" alt="Nuxt" loading="lazy" />
        <UAvatar src="https://github.com/unjs.png" alt="Unjs" loading="lazy" />
      </UAvatarGroup>
    </template>

    <template #footer>
      <USeparator class="my-4" />

      <div class="grid grid-cols-2 gap-4">
        <UPageCard
          v-for="(member, index) in members"
          :key="index"
          :to="member.to"
          :ui="{ container: 'sm:p-4' }"
        >
          <UUser
            :avatar="member.avatar"
            :name="member.name"
            :description="member.description"
            :ui="{ name: 'truncate' }"
          />
        </UPageCard>
      </div>
    </template>
  </UEmpty>
</template>
```
