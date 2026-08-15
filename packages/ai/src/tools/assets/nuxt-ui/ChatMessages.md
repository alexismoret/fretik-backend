# UChatMessages

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatMessages component
 */
interface ChatMessagesProps {
  messages?: T | undefined;
  status?: "submitted" | "streaming" | "ready" | "error" | undefined;
  /**
   * Whether to automatically scroll to the bottom when a message is streaming.
   * @default false
   */
  shouldAutoScroll?: boolean | undefined;
  /**
   * Whether to scroll to the bottom on mounted.
   * @default true
   */
  shouldScrollToBottom?: boolean | undefined;
  /**
   * Display an auto scroll button.
   * `{ size: 'md', color: 'neutral', variant: 'outline' }`{lang="ts-type"}
   * @default true
   */
  autoScroll?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the auto scroll button.
   * @default appConfig.ui.icons.arrowDown
   */
  autoScrollIcon?: any;
  /**
   * The `user` messages props.
   * `{ side: 'right', variant: 'soft' }`{lang="ts-type"}
   */
  user?:
    | Pick<
        PropsBase<T>,
        "actions" | "ui" | "variant" | "icon" | "avatar" | "side"
      >
    | undefined;
  /**
   * The `assistant` messages props.
   * `{ side: 'left', variant: 'naked' }`{lang="ts-type"}
   */
  assistant?:
    | Pick<
        PropsBase<T>,
        "actions" | "ui" | "variant" | "icon" | "avatar" | "side"
      >
    | undefined;
  /**
   * Render the messages in a compact style.
   * This is done automatically when used inside a `UChatPalette`{lang="ts-type"}.
   * @default false
   */
  compact?: boolean | undefined;
  /**
   * The spacing offset for the last message in px. Can be useful when the prompt is sticky for example.
   * @default 0
   */
  spacingOffset?: number | undefined;
  ui?:
    | {
        root?: SlotClass;
        indicator?: SlotClass;
        viewport?: SlotClass;
        autoScroll?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ChatMessages component
 */
interface ChatMessagesSlots {
  default(): any;
  indicator(): any;
  viewport(): any;
  header(): any;
  leading(): any;
  files(): any;
  body(): any;
  content(): any;
  actions(): any;
}
```

> \[!TIP]
>
> You can use all the slots of the [`ChatMessage`](https://ui.nuxt.com/docs/components/chat-message#slots) component inside ChatMessages, they are automatically forwarded allowing you to customize individual messages when using the `messages` prop.
>
> ```vue {7-15}
> <script setup lang="ts">
> import { isTextUIPart } from "ai";
> </script>
>
> <template>
>   <UChatMessages :messages="messages" :status="status">
>     <template #content="{ message }">
>       <template
>         v-for="(part, index) in message.parts"
>         :key="`${message.id}-${part.type}-${index}`"
>       >
>         <p v-if="isTextUIPart(part)" class="whitespace-pre-wrap">
>           {{ part.text }}
>         </p>
>       </template>
>     </template>
>   </UChatMessages>
> </template>
> ```

### Expose

When accessing the component via a template ref, you can use the following:

| Name                                                             | Type                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `registerMessageRef(id: string, element: ComponentPublicInstance | null)`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `void`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |

## Usage

The ChatMessages component displays a list of [ChatMessage](https://ui.nuxt.com/docs/components/chat-message) components using either the default slot or the `messages` prop.

```vue {2,8}
<template>
  <UChatMessages>
    <UChatMessage
      v-for="(message, index) in messages"
      :key="index"
      v-bind="message"
    />
  </UChatMessages>
</template>
```

> \[!NOTE]
>
> This component is purpose-built for AI chatbots with features like:
>
> - Initial scroll to the bottom upon loading ([`shouldScrollToBottom`](https://ui.nuxt.com/#should-scroll-to-bottom)).
> - Continuous scrolling down as new messages arrive ([`shouldAutoScroll`](https://ui.nuxt.com/#should-auto-scroll)).
> - An "Auto scroll" button appears when scrolled up, allowing users to jump back to the latest messages ([`autoScroll`](https://ui.nuxt.com/#auto-scroll)).
> - A loading indicator displays while the assistant is processing ([`status`](https://ui.nuxt.com/#status)).
> - Submitted messages are scrolled to the top of the viewport and the height of the last user message is dynamically adjusted.

### Messages

Use the `messages` prop to display a list of chat messages.

```vue
<script setup lang="ts">
const messages = ref([
  {
    id: "6045235a-a435-46b8-989d-2df38ca2eb47",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Hello, how are you?",
      },
    ],
  },
  {
    id: "7a92b3c1-d5f8-4e76-b8a9-3c1e5fb2e0d8",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "I am doing well, thank you for asking! How can I assist you today?",
      },
    ],
  },
  {
    id: "9c84d6a7-8b23-4f12-a1d5-e7f3b9c05e2a",
    role: "user",
    parts: [
      {
        type: "text",
        text: "What is the current weather in Tokyo?",
      },
    ],
  },
  {
    id: "b2e5f8c3-a1d9-4e67-b3f2-c9d8e7a6b5f4",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Based on the latest data, Tokyo is currently experiencing sunny weather with temperatures around 24°C (75°F). It's a beautiful day with clear skies.",
      },
    ],
  },
]);
</script>

<template>
  <UChatMessages :messages="messages" />
</template>
```

### Status

Use the `status` prop to display a visual indicator when the assistant is processing.

```vue
<script setup lang="ts">
const messages = ref([
  {
    id: "6045235a-a435-46b8-989d-2df38ca2eb47",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Hello, how are you?",
      },
    ],
  },
]);
</script>

<template>
  <UChatMessages status="submitted" :messages="messages" />
</template>
```

> \[!NOTE]
>
> Here's the detail of the different statuses from the AI SDK `useChat` composable:
>
> - `submitted`: The message has been sent to the API and we're awaiting the start of the response stream.
> - `streaming`: The response is actively streaming in from the API, receiving chunks of data.
> - `ready`: The full response has been received and processed; a new user message can be submitted.
> - `error`: An error occurred during the API request, preventing successful completion.

### User

Use the `user` prop to change the [ChatMessage](https://ui.nuxt.com/docs/components/chat-message) props for `user` messages. Defaults to:

- `side: 'right'`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `variant: 'soft'`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
const messages = ref([
  {
    id: "6045235a-a435-46b8-989d-2df38ca2eb47",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Hello, how are you?",
      },
    ],
  },
  {
    id: "7a92b3c1-d5f8-4e76-b8a9-3c1e5fb2e0d8",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "I am doing well, thank you for asking! How can I assist you today?",
      },
    ],
  },
  {
    id: "9c84d6a7-8b23-4f12-a1d5-e7f3b9c05e2a",
    role: "user",
    parts: [
      {
        type: "text",
        text: "What is the current weather in Tokyo?",
      },
    ],
  },
  {
    id: "b2e5f8c3-a1d9-4e67-b3f2-c9d8e7a6b5f4",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Based on the latest data, Tokyo is currently experiencing sunny weather with temperatures around 24°C (75°F). It's a beautiful day with clear skies.",
      },
    ],
  },
]);
</script>

<template>
  <UChatMessages
    :user="{
      side: 'left',
      variant: 'solid',
      avatar: {
        src: 'https://github.com/benjamincanac.png',
        loading: 'lazy',
      },
    }"
    :messages="messages"
  />
</template>
```

### Assistant

Use the `assistant` prop to change the [ChatMessage](https://ui.nuxt.com/docs/components/chat-message) props for `assistant` messages. Defaults to:

- `side: 'left'`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `variant: 'naked'`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
const messages = ref([
  {
    id: "6045235a-a435-46b8-989d-2df38ca2eb47",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Hello, how are you?",
      },
    ],
  },
  {
    id: "7a92b3c1-d5f8-4e76-b8a9-3c1e5fb2e0d8",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "I am doing well, thank you for asking! How can I assist you today?",
      },
    ],
  },
  {
    id: "9c84d6a7-8b23-4f12-a1d5-e7f3b9c05e2a",
    role: "user",
    parts: [
      {
        type: "text",
        text: "What is the current weather in Tokyo?",
      },
    ],
  },
  {
    id: "b2e5f8c3-a1d9-4e67-b3f2-c9d8e7a6b5f4",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Based on the latest data, Tokyo is currently experiencing sunny weather with temperatures around 24°C (75°F). It's a beautiful day with clear skies.",
      },
    ],
  },
]);
</script>

<template>
  <UChatMessages
    :assistant="{
      side: 'left',
      variant: 'outline',
      avatar: {
        icon: 'i-lucide-bot',
      },
      actions: [
        {
          label: 'Copy to clipboard',
          icon: 'i-lucide-copy',
        },
      ],
    }"
    :messages="messages"
  />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

> \[!TIP]
> See: /docs/components/chat
>
> Check the **Chat** overview page for installation instructions, server setup and usage examples.

### With indicator slot

Use the `#indicator` slot to customize the loading indicator with a [`ChatShimmer`](https://ui.nuxt.com/docs/components/chat-shimmer) effect.

```vue [ChatMessagesIndicatorSlotExample.vue]
<script setup lang="ts">
import type { UIMessage } from "ai";
import { useChat } from "@ai-sdk/vue";

const initialMessages: UIMessage[] = [
  {
    id: "1",
    role: "user",
    parts: [{ type: "text", text: "Hello! Can you help me with something?" }],
  },
];

const { messages } = useChat({
  messages: initialMessages,
});

const size = 4;
const gap = 2;
const totalDots = size * size;

const patterns = [
  [
    [0],
    [1],
    [2],
    [3],
    [7],
    [11],
    [15],
    [14],
    [13],
    [12],
    [8],
    [4],
    [5],
    [6],
    [10],
    [9],
  ],
  [
    [0, 4, 8, 12],
    [1, 5, 9, 13],
    [2, 6, 10, 14],
    [3, 7, 11, 15],
  ],
  [
    [5, 6, 9, 10],
    [1, 4, 7, 8, 11, 14],
    [0, 3, 12, 15],
    [1, 4, 7, 8, 11, 14],
    [5, 6, 9, 10],
  ],
  [[0], [1, 4], [2, 5, 8], [3, 6, 9, 12], [7, 10, 13], [11, 14], [15]],
];

const activeDots = ref<Set<number>>(new Set());
let patternIndex = 0;
let stepIndex = 0;

function nextStep() {
  const pattern = patterns[patternIndex];
  if (!pattern) return;

  activeDots.value = new Set(pattern[stepIndex]);
  stepIndex++;

  if (stepIndex >= pattern.length) {
    stepIndex = 0;
    patternIndex = (patternIndex + 1) % patterns.length;
  }
}

const statusMessages = [
  "Searching...",
  "Reading...",
  "Analyzing...",
  "Thinking...",
];
const currentIndex = ref(0);
const displayedText = ref(statusMessages[0]!);
const chars = "abcdefghijklmnopqrstuvwxyz";

function scramble(from: string, to: string) {
  const maxLength = Math.max(from.length, to.length);
  let frame = 0;
  const totalFrames = 15;

  const step = () => {
    frame++;
    let result = "";
    const progress = (frame / totalFrames) * maxLength;

    for (let i = 0; i < maxLength; i++) {
      if (i < progress - 2) {
        result += to[i] || "";
      } else if (i < progress) {
        result += chars[Math.floor(Math.random() * chars.length)];
      } else {
        result += from[i] || "";
      }
    }

    displayedText.value = result;

    if (frame < totalFrames) {
      requestAnimationFrame(step);
    } else {
      displayedText.value = to;
    }
  };

  requestAnimationFrame(step);
}

let matrixInterval: ReturnType<typeof setInterval> | undefined;
let textInterval: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  nextStep();
  matrixInterval = setInterval(nextStep, 120);
  textInterval = setInterval(() => {
    const prev = displayedText.value;
    currentIndex.value = (currentIndex.value + 1) % statusMessages.length;
    scramble(prev, statusMessages[currentIndex.value]!);
  }, 3000);
});

onUnmounted(() => {
  clearInterval(matrixInterval);
  clearInterval(textInterval);
});
</script>

<template>
  <UChatMessages
    :messages="messages"
    status="submitted"
    :should-scroll-to-bottom="false"
  >
    <template #indicator>
      <div class="flex items-center gap-2 text-muted overflow-hidden">
        <div
          class="shrink-0 grid size-4"
          :style="{
            gridTemplateColumns: `repeat(${size}, 1fr)`,
            gap: `${gap}px`,
          }"
        >
          <span
            v-for="i in totalDots"
            :key="i"
            class="rounded-sm bg-current transition-opacity duration-100"
            :class="activeDots.has(i - 1) ? 'opacity-100' : 'opacity-20'"
          />
        </div>

        <UChatShimmer :text="displayedText" class="text-sm font-mono" />
      </div>
    </template>
  </UChatMessages>
</template>
```
