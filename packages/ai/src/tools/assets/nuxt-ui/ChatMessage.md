# UChatMessage

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatMessage component
 */
interface ChatMessageProps {
  /**
   * A unique identifier for the message.
   */
  id: string;
  /**
   * The role of the message.
   */
  role: "system" | "user" | "assistant";
  /**
   * The parts of the message. Use this for rendering the message in the UI.
   * 
   * System messages should be avoided (set the system prompt on the server instead).
   * They can have text parts.
   * 
   * User messages can have text parts and file parts.
   * 
   * Assistant messages can have text, reasoning, tool invocation, and file parts.
   */
  parts: UIMessagePart<TDataParts, TTools>[];
  /**
   * The element or component this component should render as.
   * @default 'article'
   */
  as?: any;
  icon?: any;
  avatar?: AvatarProps & { [key: string]: any; } | undefined;
  /**
   * @default 'naked'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | "naked" | undefined;
  /**
   * @default 'neutral'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'left'
   */
  side?: "left" | "right" | undefined;
  /**
   * Display a list of actions under the message.
   * The `label` will be used in a tooltip.
   * `{ size: 'xs', color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   */
  actions?: (Omit<ButtonProps, "onClick"> & { onClick?: ((e: MouseEvent, message: UIMessage<TMetadata, TDataParts, TTools>) => void) | undefined; })[] | undefined;
  /**
   * Render the message in a compact style.
   * This is done automatically when used inside a `UChatPalette`{lang="ts-type"}.
   * @default false
   */
  compact?: boolean | undefined;
  content?: string | undefined;
  ui?: { root?: SlotClass; header?: SlotClass; container?: SlotClass; body?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; files?: SlotClass; content?: SlotClass; actions?: SlotClass; } | undefined;
  /**
   * The metadata of the message.
   */
  metadata?: TMetadata | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ChatMessage component
 */
interface ChatMessageSlots {
  header(): any;
  leading(): any;
  files(): any;
  body(): any;
  content(): any;
  actions(): any;
}
```

## Composition

Parts placed by name: `#files`, `#body`, `#content`, `#actions`.

## Usage

The ChatMessage component renders an `<article>` element for a `user` or `assistant` chat message.

```vue
<template>
  <u-chat-message :avatar="{
    src: 'https://github.com/benjamincanac.png',
    loading: 'lazy'
  }" :parts="[
    {
      type: 'text',
      id: '1',
      text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
    }
  ]" id="1" role="user" side="right" variant="soft" />
</template>
```

> [!TIP]
> See: /docs/components/chat-messages
> 
> Use the `ChatMessages` component to display a list of chat messages.

### Parts

Use the `parts` prop to display the message content using the AI SDK format.

```vue
<template>
  <UChatMessage :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
  }
]" role="user" id="1" />
</template>
```

> [!NOTE]
> 
> The `parts` prop is the recommended format for the AI SDK. Each part has a `type` (e.g. 'text') and corresponding content. The ChatMessage component also supports the deprecated `content` prop for backward compatibility.

### Side

Use the `side` prop to display the message on the left or right.

```vue
<template>
  <UChatMessage side="right" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
  }
]" role="user" id="1" />
</template>
```

> [!NOTE]
> 
> When using the [`ChatMessages`](https://ui.nuxt.com/docs/components/chat-messages) component, the `side` prop is set to `left` for `assistant` messages and `right` for `user` messages.

### Variant

Use the `variant` prop to change style of the message.

```vue
<template>
  <UChatMessage variant="soft" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
  }
]" role="user" id="1" />
</template>
```

> [!NOTE]
> 
> When using the [`ChatMessages`](https://ui.nuxt.com/docs/components/chat-messages) component, the `variant` prop is set to `naked` for `assistant` messages and `soft` for `user` messages.

### Color `4.8+`

Use the `color` prop to change the color of the message.

```vue
<template>
  <UChatMessage variant="soft" color="primary" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
  }
]" role="user" id="1" />
</template>
```

### Icon

Use the `icon` prop to display an [Icon](https://ui.nuxt.com/docs/components/icon) component next to the message.

```vue
<template>
  <UChatMessage icon="i-lucide-user" variant="soft" side="right" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
  }
]" role="user" id="1" />
</template>
```

### Avatar

Use the `avatar` prop to display an [Avatar](https://ui.nuxt.com/docs/components/avatar) component next to the message.

```vue
<template>
  <UChatMessage :avatar="{
  src: 'https://github.com/benjamincanac.png',
  loading: 'lazy'
}" variant="soft" side="right" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Hello! Tell me more about building AI chatbots with Nuxt UI.'
  }
]" role="user" id="1" />
</template>
```

You can also use the `avatar.icon` prop to display an icon as the avatar.

```vue
<template>
  <UChatMessage :avatar="{
  icon: 'i-lucide-bot'
}" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Nuxt UI offers several features for building AI chatbots including the ChatMessage, ChatMessages, and ChatPrompt components. Best practices include using the Chat class from AI SDK, implementing proper message styling with variants, and utilizing the built-in actions for message interactions. The components are fully customizable with theming support and responsive design.'
  }
]" role="assistant" id="1" />
</template>
```

### Actions

Use the `actions` prop to display actions below the message that will be displayed when hovering over the message.

```vue
<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'

const actions = ref<ButtonProps[]>([
  {
    label: "Copy to clipboard",
    icon: "i-lucide-copy"
  }
])
</script>

<template>
  <UChatMessage :actions="actions" :parts="[
  {
    type: 'text',
    id: '1',
    text: 'Nuxt UI offers several features for building AI chatbots including the ChatMessage, ChatMessages, and ChatPrompt components. Best practices include using the Chat class from AI SDK, implementing proper message styling with variants, and utilizing the built-in actions for message interactions. The components are fully customizable with theming support and responsive design.'
  }
]" role="user" id="1" />
</template>
```

## Examples

> [!TIP]
> See: /docs/components/chat
> 
> Check the **Chat** overview page for installation instructions, server setup and usage examples.
