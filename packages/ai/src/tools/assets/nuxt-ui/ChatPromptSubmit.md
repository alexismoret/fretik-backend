# UChatPromptSubmit

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatPromptSubmit component
 */
interface ChatPromptSubmitProps {
  /**
   * @default 'ready'
   */
  status?: "error" | "ready" | "submitted" | "streaming" | undefined;
  /**
   * The icon displayed in the button when the status is `ready`. Set to `false` to hide the icon.
   * @default appConfig.ui.icons.arrowUp
   */
  icon?: any;
  /**
   * The color of the button when the status is `ready`.
   * @default 'primary'
   */
  color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * The variant of the button when the status is `ready`.
   * @default 'solid'
   */
  variant?: "link" | "outline" | "soft" | "subtle" | "ghost" | "solid" | undefined;
  /**
   * The icon displayed in the button when the status is `streaming`.
   * @default appConfig.ui.icons.stop
   */
  streamingIcon?: any;
  /**
   * The color of the button when the status is `streaming`.
   * @default 'neutral'
   */
  streamingColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * The variant of the button when the status is `streaming`.
   * @default 'subtle'
   */
  streamingVariant?: "link" | "outline" | "soft" | "subtle" | "ghost" | "solid" | undefined;
  /**
   * The icon displayed in the button when the status is `submitted`.
   * @default appConfig.ui.icons.stop
   */
  submittedIcon?: any;
  /**
   * The color of the button when the status is `submitted`.
   * @default 'neutral'
   */
  submittedColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * The variant of the button when the status is `submitted`.
   * @default 'subtle'
   */
  submittedVariant?: "link" | "outline" | "soft" | "subtle" | "ghost" | "solid" | undefined;
  /**
   * The icon displayed in the button when the status is `error`.
   * @default appConfig.ui.icons.reload
   */
  errorIcon?: any;
  /**
   * The color of the button when the status is `error`.
   * @default 'error'
   */
  errorColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * The variant of the button when the status is `error`.
   * @default 'soft'
   */
  errorVariant?: "link" | "outline" | "soft" | "subtle" | "ghost" | "solid" | undefined;
  ui?: { base?: SlotClass; } & { base?: SlotClass; label?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailingIcon?: SlotClass; } | undefined;
  autofocus?: false | true | "true" | "false" | undefined;
  /**
   * Display an avatar on the left side.
   */
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
  disabled?: boolean | undefined;
  form?: string | undefined;
  name?: string | undefined;
  onClick?: (event: MouseEvent): void | ((event: MouseEvent) => void)[] | undefined;
  /**
   * The element or component this component should render as when not a link.
   * @default 'button'
   */
  as?: any;
  label?: string | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * When `true`, the icon will be displayed on the left side.
   */
  leading?: boolean | undefined;
  /**
   * Display an icon on the left side.
   */
  leadingIcon?: any;
  /**
   * When `true`, the icon will be displayed on the right side.
   */
  trailing?: boolean | undefined;
  /**
   * Display an icon on the right side.
   */
  trailingIcon?: any;
  /**
   * The type of the button when not a link.
   * @default 'button'
   */
  type?: "reset" | "submit" | "button" | undefined;
  /**
   * Class to apply when the link is exact active
   */
  exactActiveClass?: string | undefined;
  /**
   * Pass the returned promise of `router.push()` to `document.startViewTransition()` if supported.
   */
  viewTransition?: boolean | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  activeColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  activeVariant?: "link" | "outline" | "soft" | "subtle" | "ghost" | "solid" | undefined;
  /**
   * Render the button with equal padding on all sides.
   */
  square?: boolean | undefined;
  /**
   * Render the button full width.
   */
  block?: boolean | undefined;
  /**
   * Set loading state automatically based on the `@click` promise state
   */
  loadingAuto?: boolean | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
> 
> This component also supports all native `<button>` HTML attributes.

### Slots

```ts
/**
 * Slots for the ChatPromptSubmit component
 */
interface ChatPromptSubmitSlots {
  leading(): any;
  default(): any;
  trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the ChatPromptSubmit component
 */
interface ChatPromptSubmitEmits {
  stop: (payload: [event: MouseEvent]) => void;
  reload: (payload: [event: MouseEvent]) => void;
}
```

## Usage

The ChatPromptSubmit component is used inside the [ChatPrompt](https://ui.nuxt.com/docs/components/chat-prompt) component to submit the prompt. It automatically handles the different `status` values to control the chat.

It extends the [Button](https://ui.nuxt.com/docs/components/button) component, so you can pass any property such as `color`, `variant`, `size`, etc.

```vue
<template>
  <UChatPrompt>
    <UChatPromptSubmit />
  </UChatPrompt>
</template>
```

> [!NOTE]
> 
> You can also use it inside the `footer` slot of the [`ChatPrompt`](https://ui.nuxt.com/docs/components/chat-prompt) component.

### Ready

When its status is `ready`, use the `color`, `variant` and `icon` props to customize the Button. Defaults to:

- `color="primary"`
- `variant="solid"`
- `icon="i-lucide-arrow-up"`

```vue
<template>
  <UChatPromptSubmit color="primary" variant="solid" icon="i-lucide-arrow-up" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.arrowUp` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.arrowUp` key.

### Submitted

When its status is `submitted`, use the `submitted-color`, `submitted-variant` and `submitted-icon` props to customize the Button. Defaults to:

- `submittedColor="neutral"`
- `submittedVariant="subtle"`
- `submittedIcon="i-lucide-square"`

> [!NOTE]
> 
> The `stop` event is emitted when the user clicks on the Button.

```vue
<template>
  <UChatPromptSubmit submitted-color="neutral" submitted-variant="subtle" submitted-icon="i-lucide-square" status="submitted" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.stop` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.stop` key.

### Streaming

When its status is `streaming`, use the `streaming-color`, `streaming-variant` and `streaming-icon` props to customize the Button. Defaults to:

- `streamingColor="neutral"`
- `streamingVariant="subtle"`
- `streamingIcon="i-lucide-square"`

> [!NOTE]
> 
> The `stop` event is emitted when the user clicks on the Button.

```vue
<template>
  <UChatPromptSubmit streaming-color="neutral" streaming-variant="subtle" streaming-icon="i-lucide-square" status="streaming" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.stop` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.stop` key.

### Error

When its status is `error`, use the `error-color`, `error-variant` and `error-icon` props to customize the Button. Defaults to:

- `errorColor="error"`
- `errorVariant="soft"`
- `errorIcon="i-lucide-rotate-ccw"`

> [!NOTE]
> 
> The `reload` event is emitted when the user clicks on the Button.

```vue
<template>
  <UChatPromptSubmit error-color="error" error-variant="soft" error-icon="i-lucide-rotate-ccw" status="error" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.reload` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.reload` key.

## Examples

> [!TIP]
> See: /docs/components/chat
> 
> Check the **Chat** overview page for installation instructions, server setup and usage examples.
