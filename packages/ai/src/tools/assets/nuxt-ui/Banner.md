# UBanner

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Banner component
 */
interface BannerProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * A unique id saved to local storage to remember if the banner has been dismissed.
   * Without an explicit id, the banner will not be persisted and will reappear on page reload.
   */
  id?: string | undefined;
  /**
   * The icon displayed next to the title.
   */
  icon?: any;
  title?: string | undefined;
  /**
   * Display a list of actions next to the title.
   * `{ color: 'neutral', size: 'xs' }`{lang="ts-type"}
   */
  actions?: ButtonProps[] | undefined;
  to?: string | it | et | undefined;
  target?:
    null | "_blank" | "_parent" | "_self" | "_top" | (string & {}) | undefined;
  /**
   * @default 'primary'
   */
  color?:
    | "error"
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | "neutral"
    | undefined;
  /**
   * Display a close button to dismiss the banner.
   * `{ size: 'md', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default false
   */
  close?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the close button.
   * @default appConfig.ui.icons.close
   */
  closeIcon?: any;
  ui?:
    | {
        root?: SlotClass;
        container?: SlotClass;
        left?: SlotClass;
        center?: SlotClass;
        right?: SlotClass;
        icon?: SlotClass;
        title?: SlotClass;
        actions?: SlotClass;
        close?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Banner component
 */
interface BannerSlots {
  leading(): any;
  title(): any;
  actions(): any;
  close(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Banner component
 */
interface BannerEmits {
  close: (payload: []) => void;
}
```

## Usage

### Title

Use the `title` prop to display a title on the Banner.

```vue
<template>
  <UBanner title="This is a banner with an important message." />
</template>
```

### Icon

Use the `icon` prop to display an icon on the Banner.

```vue
<template>
  <UBanner icon="i-lucide-info" title="This is a banner with an icon." />
</template>
```

### Color

Use the `color` prop to change the color of the Banner.

```vue
<template>
  <UBanner
    color="neutral"
    icon="i-lucide-info"
    title="This is a banner with an icon."
  />
</template>
```

### Close

Use the `close` prop to display a [Button](https://ui.nuxt.com/docs/components/button) to dismiss the Banner. Defaults to `false`.

> \[!TIP]
>
> A `close` event will be emitted when the close button is clicked.

```vue [BannerExample.vue]
<script setup lang="ts">
import type { BannerProps } from "@nuxt/ui";

const { id = "example" } = defineProps<{
  id?: string;
  title?: string;
  color?: BannerProps["color"];
  closeIcon?: string;
}>();

function onClose() {
  localStorage.removeItem(`banner-${id}`);

  setTimeout(() => {
    document.querySelector("html")?.classList.remove("hide-banner");
  }, 1000);
}

onBeforeMount(() => {
  localStorage.removeItem(`banner-${id}`);
});
</script>

<template>
  <UBanner
    :id="id"
    :title="title || 'This is a closable banner'"
    :color="color"
    :close-icon="closeIcon"
    close
    @close="onClose"
  />
</template>
```

> \[!NOTE]
>
> When closed, `banner-${id}` will be stored in the local storage to prevent it from being displayed again. :br For the example above, `banner-example` will be stored in the local storage.

> \[!CAUTION]
>
> To persist the dismissed state across page reloads, you must specify an `id` prop. Without an explicit `id`, the banner will only be hidden for the current session and will reappear on page reload.

### Close Icon

Use the `close-icon` prop to customize the close button [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-x`.

```vue [BannerExample.vue]
<script setup lang="ts">
import type { BannerProps } from "@nuxt/ui";

const { id = "example" } = defineProps<{
  id?: string;
  title?: string;
  color?: BannerProps["color"];
  closeIcon?: string;
}>();

function onClose() {
  localStorage.removeItem(`banner-${id}`);

  setTimeout(() => {
    document.querySelector("html")?.classList.remove("hide-banner");
  }, 1000);
}

onBeforeMount(() => {
  localStorage.removeItem(`banner-${id}`);
});
</script>

<template>
  <UBanner
    :id="id"
    :title="title || 'This is a closable banner'"
    :color="color"
    :close-icon="closeIcon"
    close
    @close="onClose"
  />
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize this icon globally in your `app.config.ts` under `ui.icons.close` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.close` key.

### Actions

Use the `actions` prop to add some [Button](https://ui.nuxt.com/docs/components/button) actions to the Banner.

```vue
<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";

const actions = ref<ButtonProps[]>([
  {
    label: "Action 1",
    variant: "outline",
  },
  {
    label: "Action 2",
    trailingIcon: "i-lucide-arrow-right",
  },
]);
</script>

<template>
  <UBanner title="This is a banner with actions." :actions="actions" />
</template>
```

> \[!NOTE]
>
> The action buttons default to `color="neutral"` and `size="xs"`. You can customize these values by passing them directly to each action button.

### Link

You can pass any property from the [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link){rel="&#x22;nofollow&#x22;"} component such as `to`, `target`, `rel`, etc.

```vue
<template>
  <UBanner
    to="https://nuxtlabs.com/"
    target="_blank"
    title="NuxtLabs is joining Vercel!"
    color="primary"
  />
</template>
```

> \[!NOTE]
>
> The `NuxtLink` component will inherit all other attributes you pass to the `User` component.

## Examples

### Within `app.vue`

Use the Banner component in your `app.vue` or in a layout:

```vue [app.vue] {3}
<template>
  <UApp>
    <UBanner
      icon="i-lucide-construction"
      title="Nuxt UI v4 has been released!"
    />

    <UHeader />

    <UMain>
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </UMain>

    <UFooter />
  </UApp>
</template>
```
