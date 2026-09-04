# UTabs

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Tabs component
 */
interface TabsProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  items?: T[] | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'pill'
   */
  variant?: "pill" | "link" | undefined;
  /**
   * @default 'md'
   */
  size?: "sm" | "xs" | "md" | "lg" | "xl" | undefined;
  /**
   * The orientation of the tabs.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * The content of the tabs, can be disabled to prevent rendering the content.
   * @default true
   */
  content?: boolean | undefined;
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
  ui?: { root?: SlotClass; list?: SlotClass; indicator?: SlotClass; trigger?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; label?: SlotClass; trailingBadge?: SlotClass; trailingBadgeSize?: SlotClass; content?: SlotClass; } | undefined;
  /**
   * The value of the tab that should be active when initially rendered. Use when you do not need to control the state of the tabs
   * @default '0'
   */
  defaultValue?: string | number | undefined;
  /**
   * The controlled value of the tab to activate. Can be bind as `v-model`.
   */
  modelValue?: string | number | undefined;
  /**
   * Whether a tab is activated automatically (on focus) or manually (on click).
   * @default automatic
   */
  activationMode?: "automatic" | "manual" | undefined;
  /**
   * When `true`, the element will be unmounted on closed state.
   * @default true
   */
  unmountOnHide?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Tabs component
 */
interface TabsSlots {
  leading(): any;
  default(): any;
  trailing(): any;
  content(): any;
  list-leading(): any;
  list-trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Tabs component
 */
interface TabsEmits {
  update:modelValue: (payload: [payload: string | number]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `triggersRef` | `Ref<ComponentPublicInstance[]>` |

## Composition

Parts placed by name: `#content`, `#list-leading`, `#list-trailing`.

Also written in the docs and absent from the interface above — one per column or item: `#account`, `#password`.

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items: TabsItem[] = [
  {
    label: 'Account',
    icon: 'i-lucide-user'
  },
  {
    label: 'Password',
    icon: 'i-lucide-lock'
  }
]
</script>

<template>
  <UTabs :items="items" class="w-full">
    <template #content="{ item }">
      <p>This is the {{ item.label }} tab.</p>
    </template>
  </UTabs>
</template>
```

## Usage

Use the Tabs component to display a list of items in tabs.

```vue [TabsExample.vue]
<script setup lang="ts">
const items = [
  {
    label: 'Account',
    icon: 'i-lucide-user',
    slot: 'account'
  },
  {
    label: 'Password',
    icon: 'i-lucide-lock',
    slot: 'password'
  }
]

const state = reactive({
  name: 'Benjamin Canac',
  username: 'benjamincanac',
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})
</script>

<template>
  <UTabs :items="items">
    <template #account>
      <UForm :state="state" class="flex flex-col gap-4">
        <UFormField label="Name" name="name">
          <UInput v-model="state.name" class="w-full" />
        </UFormField>
        <UFormField label="Username" name="username">
          <UInput v-model="state.username" class="w-full" />
        </UFormField>
      </UForm>
    </template>

    <template #password>
      <UForm :state="state" class="flex flex-col gap-4">
        <UFormField label="Current Password" name="current" required>
          <UInput v-model="state.currentPassword" type="password" required class="w-full" />
        </UFormField>
        <UFormField label="New Password" name="new" required>
          <UInput v-model="state.newPassword" type="password" required class="w-full" />
        </UFormField>
        <UFormField label="Confirm Password" name="confirm" required>
          <UInput v-model="state.confirmPassword" type="password" required class="w-full" />
        </UFormField>
      </UForm>
    </template>
  </UTabs>
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`
- `icon?: string`
- `avatar?: AvatarProps`
- `badge?: string | number | BadgeProps`
- `content?: string`
- `value?: string | number`
- `disabled?: boolean`
- [`slot?: string`](#with-custom-slot)
- `class?: any`
- `ui?: { trigger?: ClassNameValue, leadingIcon?: ClassNameValue, leadingAvatar?: ClassNameValue, leadingAvatarSize?: ClassNameValue, label?: ClassNameValue, trailingBadge?: ClassNameValue, trailingBadgeSize?: ClassNameValue, content?: ClassNameValue }`

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items = ref<TabsItem[]>([
  {
    label: "Account",
    icon: "i-lucide-user",
    content: "This is the account content."
  },
  {
    label: "Password",
    icon: "i-lucide-lock",
    content: "This is the password content."
  }
])
</script>

<template>
  <UTabs :items="items" class="w-full" />
</template>
```

### Content

Set the `content` prop to `false` to render the triggers without any panels. Defaults to `true`.

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items = ref<TabsItem[]>([
  {
    label: "Account",
    icon: "i-lucide-user",
    content: "This is the account content."
  },
  {
    label: "Password",
    icon: "i-lucide-lock",
    content: "This is the password content."
  }
])
</script>

<template>
  <UTabs :content="false" :items="items" class="w-full" />
</template>
```

### Unmount

Use the `unmount-on-hide` prop to prevent the content from being unmounted when the Tabs is collapsed. Defaults to `true`.

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items = ref<TabsItem[]>([
  {
    label: "Account",
    icon: "i-lucide-user",
    content: "This is the account content."
  },
  {
    label: "Password",
    icon: "i-lucide-lock",
    content: "This is the password content."
  }
])
</script>

<template>
  <UTabs :unmount-on-hide="false" :items="items" class="w-full" />
</template>
```

> [!NOTE]
> 
> You can inspect the DOM to see each item's content being rendered.

### Color

Use the `color` prop to change the color of the Tabs.

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items = ref<TabsItem[]>([
  {
    label: "Account"
  },
  {
    label: "Password"
  }
])
</script>

<template>
  <UTabs color="neutral" :content="false" :items="items" class="w-full" />
</template>
```

### Variant

Use the `variant` prop to change the variant of the Tabs.

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items = ref<TabsItem[]>([
  {
    label: "Account"
  },
  {
    label: "Password"
  }
])
</script>

<template>
  <UTabs color="neutral" variant="link" :content="false" :items="items" class="w-full" />
</template>
```

### Size

Use the `size` prop to change the size of the Tabs.

```vue
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items = ref<TabsItem[]>([
  {
    label: "Account"
  },
  {
    label: "Password"
  }
])
</script>

<template>
  <UTabs size="md" variant="pill" :content="false" :items="items" class="w-full" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control active item

You can control the active item by using the `default-value` prop or the `v-model` directive with the `value` of the item. If no `value` is provided, it defaults to the index **as a string**.

```vue [TabsModelValueExample.vue]
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items: TabsItem[] = [
  {
    label: 'Account',
    icon: 'i-lucide-user'
  },
  {
    label: 'Password',
    icon: 'i-lucide-lock'
  }
]

const active = ref('0')

// Note: This is for demonstration purposes only. Don't do this at home.
onMounted(() => {
  setInterval(() => {
    active.value = String((Number(active.value) + 1) % items.length)
  }, 2000)
})
</script>

<template>
  <UTabs v-model="active" :content="false" :items="items" class="w-full" />
</template>
```

> [!TIP]
> 
> Use the `value-key` prop to change the key used to match items when a `v-model` or `default-value` is provided.

### With route query

You can control the active item by a URL query parameter, using `route.query.tab` as the `value` of the item.

```vue [TabsRouteQueryExample.vue]
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const route = useRoute()
const router = useRouter()

const items: TabsItem[] = [
  {
    label: 'Account',
    icon: 'i-lucide-user',
    value: 'account'
  },
  {
    label: 'Password',
    icon: 'i-lucide-lock',
    value: 'password'
  }
]

const active = computed({
  get() {
    return (route.query.tab as string) || 'account'
  },
  set(tab) {
    // Hash is specified here to prevent the page from scrolling to the top
    router.push({
      path: '/docs/components/tabs',
      query: { tab },
      hash: '#with-route-query'
    })
  }
})
</script>

<template>
  <UTabs v-model="active" :content="false" :items="items" class="w-full" />
</template>
```

### With content slot

Use the `#content` slot to customize the content of each item.

```vue [TabsContentSlotExample.vue]
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items: TabsItem[] = [
  {
    label: 'Account',
    icon: 'i-lucide-user'
  },
  {
    label: 'Password',
    icon: 'i-lucide-lock'
  }
]
</script>

<template>
  <UTabs :items="items" class="w-full">
    <template #content="{ item }">
      <p>This is the {{ item.label }} tab.</p>
    </template>
  </UTabs>
</template>
```

### With bottom tab bar

Use the `ui` prop to transform the Tabs into a mobile-style bottom tab bar with icons and small labels, similar to YouTube or Instagram.

```vue [TabsBottomTabBarExample.vue]
<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'

const items: TabsItem[] = [
  {
    label: 'Home',
    icon: 'i-lucide-house'
  },
  {
    label: 'Activity',
    icon: 'i-lucide-activity'
  },
  {
    label: 'Settings',
    icon: 'i-lucide-settings'
  },
  {
    label: 'Profile',
    icon: 'i-lucide-user'
  }
]
</script>

<template>
  <UTabs
    :items="items"
    :content="false"
    :ui="{
      list: 'justify-around w-full',
      trigger: 'grow flex-col gap-1 py-1',
      label: 'text-[10px]/3'
    }"
    class="w-full"
  />
</template>
```

### With custom slot

Use the `slot` property to customize a specific item.

You will have access to the following slots:

- `#{{ item.slot }}`

_(truncated — ask for fewer components to see more, or rely on the API block above)_
