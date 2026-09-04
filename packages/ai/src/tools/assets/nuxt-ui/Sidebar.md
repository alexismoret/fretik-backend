# USidebar

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Sidebar component
 */
interface SidebarProps {
  /**
   * The element or component this component should render as.
   * @default 'aside'
   */
  as?: any;
  /**
   * The visual variant of the sidebar.
   * @default 'sidebar'
   */
  variant?: "floating" | "sidebar" | "inset" | undefined;
  /**
   * The collapse behavior of the sidebar.
   * - `offcanvas`: The sidebar slides out of view completely.
   * - `icon`: The sidebar shrinks to icon-only width.
   * - `none`: The sidebar is not collapsible.
   * @default 'offcanvas'
   */
  collapsible?: "offcanvas" | "icon" | "none" | undefined;
  /**
   * The side to render the sidebar on.
   * @default 'left'
   */
  side?: "left" | "right" | undefined;
  /**
   * The title displayed in the sidebar header.
   */
  title?: string | undefined;
  /**
   * The description displayed in the sidebar header.
   */
  description?: string | undefined;
  /**
   * Display a close button to collapse the sidebar.
   * Only renders when `collapsible` is not `none`.
   * `{ size: 'md', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default false
   */
  close?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the close button.
   * @default appConfig.ui.icons.close
   */
  closeIcon?: any;
  /**
   * Display a rail on the sidebar edge to toggle collapse.
   * Only renders when `collapsible` is not `none`.
   * @default false
   */
  rail?: boolean | undefined;
  /**
   * Animate the sidebar when collapsing or expanding.
   * @default true
   */
  transition?: boolean | undefined;
  /**
   * The mode of the sidebar menu on mobile.
   * @default 'slideover'
   */
  mode?: T | undefined;
  /**
   * The props for the sidebar menu component on mobile.
   */
  menu?: SidebarMenu<T> | undefined;
  ui?: { root?: SlotClass; gap?: SlotClass; container?: SlotClass; inner?: SlotClass; header?: SlotClass; wrapper?: SlotClass; title?: SlotClass; description?: SlotClass; actions?: SlotClass; close?: SlotClass; body?: SlotClass; footer?: SlotClass; rail?: SlotClass; } | undefined;
  /**
   * @default true
   */
  open?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Sidebar component
 */
interface SidebarSlots {
  header(): any;
  title(): any;
  description(): any;
  actions(): any;
  close(): any;
  default(): any;
  footer(): any;
  rail(): any;
  content(): any;
}
```

## Composition

Parts placed by name: `#actions`, `#close`, `#rail`, `#content`.

Also written in the docs and absent from the interface above — one per column or item: `#toggle`.

## Usage

The Sidebar component is a standalone, fixed sidebar that pushes the page content. On desktop, it renders inline and can be collapsed; on mobile, it opens a [Modal](https://ui.nuxt.com/docs/components/modal), [Slideover](https://ui.nuxt.com/docs/components/slideover) or [Drawer](https://ui.nuxt.com/docs/components/drawer) component.

> [!TIP]
> See: /docs/components/dashboard-sidebar
> 
> **Sidebar vs DashboardSidebar**: This component is a simple, standalone sidebar you can drop anywhere (chat panel, settings, navigation). If you need drag-to-resize, state persistence and integration with [DashboardGroup](https://ui.nuxt.com/docs/components/dashboard-group), use [DashboardSidebar](https://ui.nuxt.com/docs/components/dashboard-sidebar) instead.

Use the `header`, `default` and `footer` slots to customize the sidebar content. The `v-model:open` directive is viewport-aware: on desktop it controls the expanded/collapsed state, on mobile it controls the menu.

```vue [SidebarExample.vue]
<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

const open = ref(true)

const colorMode = useColorMode()

const teams = ref([{
  label: 'Nuxt',
  avatar: {
    src: 'https://github.com/nuxt.png',
    alt: 'Nuxt'
  }
}, {
  label: 'Vue',
  avatar: {
    src: 'https://github.com/vuejs.png',
    alt: 'Vue'
  }
}, {
  label: 'UnJS',
  avatar: {
    src: 'https://github.com/unjs.png',
    alt: 'UnJS'
  }
}])
const selectedTeam = ref(teams.value[0])

const teamsItems = computed<DropdownMenuItem[][]>(() => {
  return [teams.value.map((team, index) => ({
    ...team,
    kbds: ['meta', String(index + 1)],
    onSelect() {
      selectedTeam.value = team
    }
  })), [{
    label: 'Create team',
    icon: 'i-lucide-circle-plus'
  }]]
})

function getItems(state: 'collapsed' | 'expanded') {
  return [{
    label: 'Inbox',
    icon: 'i-lucide-inbox',
    badge: '4'
  }, {
    label: 'Issues',
    icon: 'i-lucide-square-dot'
  }, {
    label: 'Activity',
    icon: 'i-lucide-square-activity'
  }, {
    label: 'Settings',
    icon: 'i-lucide-settings',
    defaultOpen: true,
    children: state === 'expanded'
      ? [{
          label: 'General',
          icon: 'i-lucide-house'
        }, {
          label: 'Team',
          icon: 'i-lucide-users'
        }, {
          label: 'Billing',
          icon: 'i-lucide-credit-card'
        }]
      : []
  }] satisfies NavigationMenuItem[]
}

const user = ref({
  name: 'Benjamin Canac',
  avatar: {
    src: 'https://github.com/benjamincanac.png',
    alt: 'Benjamin Canac'
  }
})

const userItems = computed<DropdownMenuItem[][]>(() => ([[{
  label: 'Profile',
  icon: 'i-lucide-user'
}, {
  label: 'Billing',
  icon: 'i-lucide-credit-card'
}, {
  label: 'Settings',
  icon: 'i-lucide-settings',
  to: '/settings'
}], [{
  label: 'Appearance',
  icon: 'i-lucide-sun-moon',
  children: [{
    label: 'Light',
    icon: 'i-lucide-sun',
    type: 'checkbox',
    checked: colorMode.value === 'light',
    onUpdateChecked(checked: boolean) {
      if (checked) {
        colorMode.preference = 'light'
      }
    },
    onSelect(e: Event) {
      e.preventDefault()
    }
  }, {
    label: 'Dark',
    icon: 'i-lucide-moon',
    type: 'checkbox',
    checked: colorMode.value === 'dark',
    onUpdateChecked(checked: boolean) {
      if (checked) {
        colorMode.preference = 'dark'
      }
    },
    onSelect(e: Event) {
      e.preventDefault()
    }
  }]
}], [{
  label: 'GitHub',
  icon: 'i-simple-icons-github',
  to: 'https://github.com/nuxt/ui',
  target: '_blank'
}, {
  label: 'Log out',
  icon: 'i-lucide-log-out'
}]]))

defineShortcuts(extractShortcuts(teamsItems.value))
</script>

<template>
  <div class="flex flex-1">
    <USidebar
      v-model:open="open"
      collapsible="icon"
      rail
      :ui="{
        container: 'h-full',
        inner: 'bg-elevated/25 divide-transparent',
        body: 'py-0'
      }"
    >
      <template #header>
        <UDropdownMenu
          :items="teamsItems"
          :content="{ align: 'start', collisionPadding: 12 }"
          :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-48' }"
        >
          <UButton
            v-bind="selectedTeam"
            trailing-icon="i-lucide-chevrons-up-down"
            color="neutral"
            variant="ghost"
            square
            class="w-full data-[state=open]:bg-elevated overflow-hidden"
            :ui="{
              trailingIcon: 'text-dimmed ms-auto'
            }"
          />
        </UDropdownMenu>
      </template>

      <template #default="{ state }">
        <UNavigationMenu
          :key="state"
          :items="getItems(state)"
          orientation="vertical"
          :ui="{ link: 'p-1.5 overflow-hidden' }"
        />
      </template>

      <template #footer>
        <UDropdownMenu
          :items="userItems"
          :content="{ align: 'center', collisionPadding: 12 }"
          :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-48' }"
        >
          <UButton
            v-bind="user"
            :label="user?.name"
            trailing-icon="i-lucide-chevrons-up-down"
            color="neutral"
            variant="ghost"
            square
            class="w-full data-[state=open]:bg-elevated overflow-hidden"
            :ui="{
              trailingIcon: 'text-dimmed ms-auto'
            }"
          />
        </UDropdownMenu>
      </template>
    </USidebar>

    <div class="flex-1 flex flex-col">
      <div class="h-(--ui-header-height) shrink-0 flex items-center px-4 border-b border-default">
        <UButton
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          aria-label="Toggle sidebar"
          @click="open = !open"
        />
      </div>

      <div class="flex-1 p-4">
        <Placeholder class="size-full" />
      </div>
    </div>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control open state

You can control the open state by using the `open` prop or the `v-model:open` directive. On desktop it controls the expanded/collapsed state, on mobile it opens/closes the sheet menu.

```vue [SidebarOpenExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const open = ref(true)

defineShortcuts({
  o: () => open.value = !open.value
})

const items: NavigationMenuItem[] = [{
  label: 'Home',
  icon: 'i-lucide-house',
  active: true
}, {
  label: 'Inbox',
  icon: 'i-lucide-inbox',
  badge: '4'
}, {
  label: 'Contacts',
  icon: 'i-lucide-users'
}]
</script>

<template>
  <div class="flex flex-1">
    <USidebar v-model:open="open" title="Navigation" collapsible="icon">
      <UNavigationMenu
        :items="items"
        orientation="vertical"
        :ui="{ link: 'p-1.5 overflow-hidden' }"
      />
    </USidebar>

    <div class="flex-1 flex flex-col">
      <div class="h-(--ui-header-height) shrink-0 flex items-center px-4 border-b border-default">
        <UButton
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          :aria-label="open ? 'Close sidebar' : 'Open sidebar'"
          @click="open = !open"
        />
      </div>

      <div class="flex-1 p-4">
        <Placeholder class="size-full" />
      </div>
    </div>
  </div>
</template>
```

> [!NOTE]
> 
> In this example, leveraging [`defineShortcuts`](https://ui.nuxt.com/docs/composables/define-shortcuts), you can toggle the open state of the Sidebar by pressing `O`.

### Persist open state

Use [`useLocalStorage`](https://vueuse.org/core/useLocalStorage/) from VueUse or [`useCookie`](https://nuxt.com/docs/4.x/api/composables/use-cookie) instead of `ref` to persist the sidebar state across page reloads.

```vue [SidebarPersistExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const open = useLocalStorage('sidebar-open', true)

defineShortcuts({
  o: () => open.value = !open.value
})

const items: NavigationMenuItem[] = [{
  label: 'Home',
  icon: 'i-lucide-house',
  active: true
}, {
  label: 'Inbox',
  icon: 'i-lucide-inbox',
  badge: '4'
}, {
  label: 'Contacts',
  icon: 'i-lucide-users'
}]
</script>

<template>
  <div class="flex flex-1">
    <USidebar v-model:open="open" title="Navigation" collapsible="icon">
      <UNavigationMenu
        :items="items"
        orientation="vertical"
        :ui="{ link: 'p-1.5 overflow-hidden' }"
      />
    </USidebar>

    <div class="flex-1 flex flex-col">
      <div class="h-(--ui-header-height) shrink-0 flex items-center px-4 border-b border-default">
        <UButton
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          aria-label="Toggle sidebar"
          @click="open = !open"
        />
      </div>

      <div class="flex-1 p-4">
        <Placeholder class="size-full" />
      </div>
    </div>
  </div>
</template>
```

> [!NOTE]
> 
> The only difference with the previous example is replacing `ref(true)` with `useLocalStorage('sidebar-open', true)`.

### With custom width

The sidebar width is controlled by the `--sidebar-width` CSS variable (defaults to `16rem`). The collapsed icon width is controlled by `--sidebar-width-icon` (defaults to `4rem`).

Override them globally in your CSS or per-instance with the `style` attribute.

```vue [SidebarWidthExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const open = ref(true)

const items: NavigationMenuItem[] = [{
  label: 'Home',
  icon: 'i-lucide-house',
  active: true
}, {
  label: 'Inbox',
  icon: 'i-lucide-inbox',
  badge: '4'
}, {
  label: 'Contacts',
  icon: 'i-lucide-users'
}]
</script>

<template>
  <div class="flex flex-1">
    <USidebar
      v-model:open="open"
      collapsible="icon"
      :style="{ '--sidebar-width': '20rem' }"
    >
      <UNavigationMenu
        :items="items"
        orientation="vertical"
        :ui="{ link: 'p-1.5 overflow-hidden' }"
      />
    </USidebar>

    <div class="flex-1 flex flex-col">
      <div class="h-(--ui-header-height) shrink-0 flex items-center px-4 border-b border-default">
        <UButton
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          aria-label="Toggle sidebar"
          @click="open = !open"
        />
      </div>

      <div class="flex-1 p-4">
        <Placeholder class="size-full" />
      </div>
    </div>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
