# UAlert

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Alert component
 */
interface AlertProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  icon?: any;
  avatar?: AvatarProps | undefined;
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
   * @default 'solid'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | undefined;
  /**
   * The orientation between the content and the actions.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * Display a list of actions:
   * - under the title and description when orientation is `vertical`
   * - next to the close button when orientation is `horizontal`
   * `{ size: 'xs' }`{lang="ts-type"}
   */
  actions?: ButtonProps[] | undefined;
  /**
   * Display a close button to dismiss the alert.
   * `{ size: 'md', color: 'neutral', variant: 'link' }`{lang="ts-type"}
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
        wrapper?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
        icon?: SlotClass;
        avatar?: SlotClass;
        avatarSize?: SlotClass;
        actions?: SlotClass;
        close?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Alert component
 */
interface AlertSlots {
  leading(): any;
  title(): any;
  description(): any;
  actions(): any;
  close(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Alert component
 */
interface AlertEmits {
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

### Title

Use the `title` prop to set the title of the Alert.

```vue
<template>
  <UAlert title="Heads up!" />
</template>
```

### Description

Use the `description` prop to set the description of the Alert.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
  />
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon).

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    icon="i-lucide-terminal"
  />
</template>
```

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar).

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    :avatar="{
      src: 'https://github.com/nuxt.png',
    }"
  />
</template>
```

### Color

Use the `color` prop to change the color of the Alert.

```vue
<template>
  <UAlert
    color="neutral"
    title="Heads up!"
    description="You can change the primary color in your app config."
    icon="i-lucide-terminal"
  />
</template>
```

### Variant

Use the `variant` prop to change the variant of the Alert.

```vue
<template>
  <UAlert
    color="neutral"
    variant="subtle"
    title="Heads up!"
    description="You can change the primary color in your app config."
    icon="i-lucide-terminal"
  />
</template>
```

### Close

Use the `close` prop to display a [Button](https://ui.nuxt.com/docs/components/button) to dismiss the Alert.

> \[!TIP]
>
> An `update:open` event will be emitted when the close button is clicked.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    color="neutral"
    variant="outline"
    close
  />
</template>
```

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button) component to customize it.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    color="neutral"
    variant="outline"
    :close="{
      color: 'primary',
      variant: 'outline',
      class: 'rounded-full',
    }"
  />
</template>
```

### Close Icon

Use the `close-icon` prop to customize the close button [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-x`.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    color="neutral"
    variant="outline"
    close
    close-icon="i-lucide-arrow-right"
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

Use the `actions` prop to add some [Button](https://ui.nuxt.com/docs/components/button) actions to the Alert.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    color="neutral"
    variant="outline"
    :actions="[
      {
        label: 'Action 1',
      },
      {
        label: 'Action 2',
        color: 'neutral',
        variant: 'subtle',
      },
    ]"
  />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the Alert.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    color="neutral"
    variant="outline"
    orientation="horizontal"
    :actions="[
      {
        label: 'Action 1',
      },
      {
        label: 'Action 2',
        color: 'neutral',
        variant: 'subtle',
      },
    ]"
  />
</template>
```

## Examples

### `class` prop

Use the `class` prop to override the base styles of the Alert.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    class="rounded-none"
  />
</template>
```

### `ui` prop

Use the `ui` prop to override the slots styles of the Alert.

```vue
<template>
  <UAlert
    title="Heads up!"
    description="You can change the primary color in your app config."
    icon="i-lucide-rocket"
    :ui="{
      icon: 'size-11',
    }"
  />
</template>
```
