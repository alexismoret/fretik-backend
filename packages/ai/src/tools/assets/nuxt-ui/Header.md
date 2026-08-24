# UHeader

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Header component
 */
interface HeaderProps {
  /**
   * The element or component this component should render as.
   * @default 'header'
   */
  as?: any;
  /**
   * @default 'Nuxt UI'
   */
  title?: string | undefined;
  /**
   * @default '/'
   */
  to?: string | undefined;
  /**
   * The mode of the header menu.
   * @default 'modal'
   */
  mode?: T | undefined;
  /**
   * The props for the header menu component.
   */
  menu?: HeaderMenu<T> | undefined;
  /**
   * Customize the toggle button to open the header menu displayed when the `content` slot is used.
   * `{ color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   * @default true
   */
  toggle?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The side to render the toggle button on.
   * @default 'right'
   */
  toggleSide?: "left" | "right" | undefined;
  /**
   * Automatically close when route changes.
   * @default true
   */
  autoClose?: boolean | undefined;
  ui?:
    | {
        root?: SlotClass;
        container?: SlotClass;
        left?: SlotClass;
        center?: SlotClass;
        right?: SlotClass;
        title?: SlotClass;
        toggle?: SlotClass;
        content?: SlotClass;
        overlay?: SlotClass;
        header?: SlotClass;
        body?: SlotClass;
      }
    | undefined;
  /**
   * @default false
   */
  open?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Header component
 */
interface HeaderSlots {
  title(): any;
  left(): any;
  default(): any;
  right(): any;
  toggle(): any;
  top(): any;
  bottom(): any;
  body(): any;
  content(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Header component
 */
interface HeaderEmits {
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

The Header component renders a `<header>` element.

> \[!TIP]
> See: /docs/getting-started/theme/css-variables#header
>
> Its height is defined through a `--ui-header-height` CSS variable.

Use the `left`, `default` and `right` slots to customize the header and the `body` or `content` slots to customize the header menu.

```vue [HeaderExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: "Docs",
    to: "/docs/getting-started",
    active: route.path.startsWith("/docs/getting-started"),
  },
  {
    label: "Components",
    to: "/docs/components",
    active: route.path.startsWith("/docs/components"),
  },
  {
    label: "Figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);
</script>

<template>
  <UHeader>
    <template #title>
      <Logo class="h-6 w-auto" />
    </template>

    <UNavigationMenu :items="items" />

    <template #right>
      <UColorModeButton />

      <UTooltip text="Open on GitHub" :kbds="['meta', 'G']">
        <UButton
          color="neutral"
          variant="ghost"
          to="https://github.com/nuxt/ui"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
        />
      </UTooltip>
    </template>
  </UHeader>
</template>
```

> \[!NOTE]
>
> In this example, we use the [NavigationMenu](https://ui.nuxt.com/docs/components/navigation-menu) component to render the header links in the center.

### Title

Use the `title` prop to change the title of the header. Defaults to `Nuxt UI`.

```vue
<template>
  <UHeader title="Nuxt UI" />
</template>
```

You can also use the `title` slot to add your own logo.

> \[!TIP]
> See: #props
>
> You should still add the `title` prop to replace the default `aria-label` of the link.

```vue
<template>
  <UHeader>
    <template #title>
      <Logo class="h-6 w-auto" /> </template
  ></UHeader>
</template>
```

### To

Use the `to` prop to change the link of the title. Defaults to `/`.

```vue
<template>
  <UHeader to="/docs" />
</template>
```

You can also use the `left` slot to override the link entirely.

```vue
<template>
  <UHeader>
    <template #left>
      <NuxtLink to="/docs">
        <Logo class="h-6 w-auto" />
      </NuxtLink> </template
  ></UHeader>
</template>
```

### Mode

Use the `mode` prop to change the mode of the header menu. Defaults to `modal`.

Use the `body` slot to fill the menu body (under the header) or the `content` slot to fill the entire menu.

> \[!TIP]
> See: #props
>
> You can use the `menu` prop to customize the menu of the header, it will adapt depending on the mode you choose.

```vue [HeaderMenuExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: "Docs",
    to: "/docs/getting-started",
    icon: "i-lucide-book-open",
    active: route.path.startsWith("/docs/getting-started"),
  },
  {
    label: "Components",
    to: "/docs/components",
    icon: "i-lucide-box",
    active: route.path.startsWith("/docs/components"),
  },
  {
    label: "Figma",
    icon: "i-simple-icons-figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);
</script>

<template>
  <UHeader>
    <template #title>
      <Logo class="h-6 w-auto" />
    </template>

    <UNavigationMenu :items="items" />

    <template #right>
      <UColorModeButton />

      <UTooltip text="Open on GitHub" :kbds="['meta', 'G']">
        <UButton
          color="neutral"
          variant="ghost"
          to="https://github.com/nuxt/ui"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
        />
      </UTooltip>
    </template>

    <template #body>
      <UNavigationMenu :items="items" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>
</template>
```

### Toggle

Use the `toggle` prop to customize the toggle button displayed on mobile.

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button) component to customize it.

```vue [HeaderToggleExample.vue]
<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: "Docs",
    to: "/docs/getting-started",
    icon: "i-lucide-book-open",
    active: route.path.startsWith("/docs/getting-started"),
  },
  {
    label: "Components",
    to: "/docs/components",
    icon: "i-lucide-box",
    active: route.path.startsWith("/docs/components"),
  },
  {
    label: "Figma",
    icon: "i-simple-icons-figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);
</script>

<template>
  <UHeader
    :toggle="{
      color: 'primary',
      variant: 'subtle',
      class: 'rounded-full',
    }"
  >
    <template #title>
      <Logo class="h-6 w-auto" />
    </template>

    <UNavigationMenu :items="items" />

    <template #right>
      <UColorModeButton />

      <UTooltip text="Open on GitHub" :kbds="['meta', 'G']">
        <UButton
          color="neutral"
          variant="ghost"
          to="https://github.com/nuxt/ui"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
        />
      </UTooltip>
    </template>

    <template #body>
      <UNavigationMenu :items="items" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With animated toggle

Use the `#toggle` slot to replace the default toggle button with a custom animated hamburger icon using [Motion Vue](https://motion.dev/docs/vue/motion-component){rel="&#x22;nofollow&#x22;"}.

```vue [HeaderToggleAnimatedExample.vue]
<script setup lang="ts">
import { motion } from "motion-v";
import type { VariantType } from "motion-v";
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: "Docs",
    to: "/docs/getting-started",
    icon: "i-lucide-book-open",
    active: route.path.startsWith("/docs/getting-started"),
  },
  {
    label: "Components",
    to: "/docs/components",
    icon: "i-lucide-box",
    active: route.path.startsWith("/docs/components"),
  },
  {
    label: "Figma",
    icon: "i-simple-icons-figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    icon: "i-lucide-rocket",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);

const variants: {
  [k: string]: VariantType | ((custom: unknown) => VariantType);
} = {
  normal: {
    rotate: 0,
    y: 0,
    opacity: 1,
  },
  close: (custom: unknown) => {
    const c = custom as number;
    return {
      rotate: c === 1 ? 45 : c === 3 ? -45 : 0,
      y: c === 1 ? 6 : c === 3 ? -6 : 0,
      opacity: c === 2 ? 0 : 1,
      transition: {
        type: "spring",
        stiffness: 260,
        damping: 20,
      },
    };
  },
};
</script>

<template>
  <UHeader>
    <template #title>
      <Logo class="h-6 w-auto" />
    </template>

    <UNavigationMenu :items="items" />

    <template #right>
      <UColorModeButton />

      <UTooltip text="Open on GitHub" :kbds="['meta', 'G']">
        <UButton
          color="neutral"
          variant="ghost"
          to="https://github.com/nuxt/ui"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
        />
      </UTooltip>
    </template>

    <template #toggle="{ open, toggle, ui }">
      <UButton
        size="sm"
        variant="ghost"
        color="neutral"
        square
        :class="ui.toggle({ toggleSide: 'right' })"
        @click="toggle"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <motion.line
            x1="4"
            y1="6"
            x2="20"
            y2="6"
            :variants="variants"
            :animate="open ? 'close' : 'normal'"
            :custom="1"
            tabindex="-1"
          />
          <motion.line
            x1="4"
            y1="12"
            x2="20"
            y2="12"
            :variants="variants"
            :animate="open ? 'close' : 'normal'"
            :custom="2"
            tabindex="-1"
          />
          <motion.line
            x1="4"
            y1="18"
            x2="20"
            y2="18"
            :variants="variants"
            :animate="open ? 'close' : 'normal'"
            :custom="3"
            tabindex="-1"
          />
        </svg>
      </UButton>
    </template>

    <template #body>
      <UNavigationMenu :items="items" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>
</template>
```

### Within `app.vue`

Use the Header component in your `app.vue` or in a layout:

```vue [app.vue] {28-51}
<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";

const route = useRoute();

const items = computed<NavigationMenuItem[]>(() => [
  {
    label: "Docs",
    to: "/docs/getting-started",
    active: route.path.startsWith("/docs/getting-started"),
  },
  {
    label: "Components",
    to: "/docs/components",
    active: route.path.startsWith("/docs/components"),
  },
  {
    label: "Figma",
    to: "https://go.nuxt.com/figma-ui",
    target: "_blank",
  },
  {
    label: "Releases",
    to: "https://github.com/nuxt/ui/releases",
    target: "_blank",
  },
]);
</script>

<template>
  <UApp>
    <UHeader>
      <template #title>
        <Logo class="h-6 w-auto" />
      </template>

      <UNavigationMenu :items="items" />

      <template #right>
        <UColorModeButton />

        <UButton
          color="neutral"
          variant="ghost"
          to="https://github.com/nuxt/ui"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
        />
      </template>

      <template #body>
        <UNavigationMenu
          :items="items"
          orientation="vertical"
          class="-mx-2.5"
        />
      </template>
    </UHeader>

    <UMain>
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </UMain>

    <UFooter />
  </UApp>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
