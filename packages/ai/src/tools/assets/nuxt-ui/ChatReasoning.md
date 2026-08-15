# UChatReasoning

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatReasoning component
 */
interface ChatReasoningProps {
  /**
   * The reasoning text content to display.
   */
  text?: string | undefined;
  /**
   * Whether the reasoning content is currently streaming.
   * @default false
   */
  streaming?: boolean | undefined;
  /**
   * The duration in seconds that the AI spent reasoning.
   * If not provided, it will be calculated automatically based on streaming time.
   */
  duration?: number | undefined;
  /**
   * The icon displayed next to the trigger.
   */
  icon?: any;
  /**
   * The position of the chevron icon.
   * @default 'trailing'
   */
  chevron?: "leading" | "trailing" | undefined;
  /**
   * The icon displayed as the chevron.
   * @default appConfig.ui.icons.chevronDown
   */
  chevronIcon?: any;
  /**
   * The delay in milliseconds before auto-closing when streaming ends.
   * Set to `0` to disable auto-close.
   * @default 500
   */
  autoCloseDelay?: number | undefined;
  /**
   * Customize the [`ChatShimmer`](https://ui.nuxt.com/docs/components/chat-shimmer) component when streaming.
   */
  shimmer?: Partial<Omit<ChatShimmerProps, "text">> | undefined;
  ui?:
    | {
        root?: SlotClass;
        trigger?: SlotClass;
        leading?: SlotClass;
        leadingIcon?: SlotClass;
        chevronIcon?: SlotClass;
        label?: SlotClass;
        trailingIcon?: SlotClass;
        content?: SlotClass;
        body?: SlotClass;
      }
    | undefined;
  /**
   * When `true`, prevents the user from interacting with the collapsible.
   */
  disabled?: boolean | undefined;
  /**
   * The controlled open state of the collapsible. Can be binded with `v-model`.
   * @default undefined
   */
  open?: boolean | undefined;
  /**
   * The open state of the collapsible when it is initially rendered. <br> Use when you do not need to control its open state.
   */
  defaultOpen?: boolean | undefined;
  /**
   * When `true`, the element will be unmounted on closed state.
   * @default false
   */
  unmountOnHide?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ChatReasoning component
 */
interface ChatReasoningSlots {
  default(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the ChatReasoning component
 */
interface ChatReasoningEmits {
  update:open: (payload: [value: boolean]) => void;
}
```

## Usage

The ChatReasoning component renders a collapsible block that displays AI reasoning or thinking content. It auto-opens during streaming and auto-closes after.

```vue [ChatReasoningExample.vue]
<script setup lang="ts">
const streaming = ref(false);
const text = ref("");

async function simulateStreaming() {
  streaming.value = true;
  text.value = "";

  const content =
    "The user is asking about Vue components. I should explain the Composition API pattern and how it relates to their question about reactive state management. Let me think about the best way to structure this response.\n\nFirst, I need to consider the key differences between the Options API and Composition API. The Composition API was introduced in Vue 3 to address limitations of the Options API when building large-scale applications.\n\nFor reactive state management specifically, the Composition API offers ref() for primitive values and reactive() for objects.";

  for (const char of content) {
    text.value += char;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  streaming.value = false;
}

onMounted(simulateStreaming);
</script>

<template>
  <UChatReasoning :text="text" :streaming="streaming" class="w-60" />
</template>
```

> \[!NOTE]
> See: /docs/composables/use-scroll-shadow
>
> The body content uses the `useScrollShadow` composable to apply fade shadows when overflowing.

### Text

Use the `text` prop to set the reasoning content. The text is displayed inside the collapsible body.

```vue
<template>
  <UChatReasoning text="The user is asking about Vue components..." />
</template>
```

### Streaming

Use the `streaming` prop to indicate active reasoning. The component auto-opens when streaming starts and auto-closes when it ends.

```vue
<template>
  <UChatReasoning streaming text="The user is asking about Vue components..." />
</template>
```

> \[!TIP]
>
> Use the `isPartStreaming` utility from `@nuxt/ui/utils/ai` to determine if a part is currently being streamed.

### Shimmer

When streaming, the trigger label uses the [`ChatShimmer`](https://ui.nuxt.com/docs/components/chat-shimmer) component. Use the `shimmer` prop to customize its `duration` and `spread`.

```vue
<template>
  <UChatReasoning
    streaming
    text="The user is asking about Vue components..."
    :shimmer="{
      duration: 2,
      spread: 2,
    }"
  />
</template>
```

### Icon

Use the `icon` prop to display an [Icon](https://ui.nuxt.com/docs/components/icon) component next to the trigger.

```vue
<template>
  <UChatReasoning
    icon="i-lucide-brain"
    text="The user is asking about Vue components..."
  />
</template>
```

### Chevron

Use the `chevron` prop to change the position of the chevron icon.

> \[!NOTE]
>
> When `chevron` is set to `leading` with an `icon`, the icon swaps with the chevron on hover and when open.

```vue
<template>
  <UChatReasoning
    chevron="leading"
    icon="i-lucide-brain"
    text="The user is asking about Vue components..."
  />
</template>
```

### Chevron Icon

Use the `chevron-icon` prop to customize the chevron [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-chevron-down`.

```vue
<template>
  <UChatReasoning
    chevron-icon="i-lucide-arrow-down"
    text="The user is asking about Vue components..."
  />
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize this icon globally in your `app.config.ts` under `ui.icons.chevronDown` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.chevronDown` key.

## Examples

> \[!TIP]
> See: /docs/components/chat
>
> Check the **Chat** overview page for installation instructions, server setup and usage examples.
