# UChatPalette

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatPalette component
 */
interface ChatPaletteProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  ui?:
    | {
        root?: SlotClass;
        prompt?: SlotClass;
        close?: SlotClass;
        content?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ChatPalette component
 */
interface ChatPaletteSlots {
  default(): any;
  prompt(): any;
}
```

## Usage

The ChatPalette component is a structured layout wrapper that organizes [ChatMessages](https://ui.nuxt.com/docs/components/chat-messages) in a scrollable content area and [ChatPrompt](https://ui.nuxt.com/docs/components/chat-prompt) in a fixed bottom section, creating cohesive chatbot interfaces for modals, slideovers, or drawers.

```vue {2,8}
<template>
  <UChatPalette>
    <UChatMessages />

    <template #prompt>
      <UChatPrompt />
    </template>
  </UChatPalette>
</template>
```

## Examples

> \[!TIP]
> See: /docs/components/chat
>
> Check the **Chat** overview page for installation instructions, server setup and usage examples.

### Within a Modal

You can use the ChatPalette component inside a [Modal](https://ui.nuxt.com/docs/components/modal)'s content.

```vue [ChatPaletteModalExample.vue]
<script setup lang="ts">
import { isTextUIPart } from "ai";
import type { UIMessage } from "ai";
import { useChat } from "@ai-sdk/vue";
import { isPartStreaming } from "@nuxt/ui/utils/ai";
import { Markdown } from "@comark/vue";
import shiki from "@comark/vue/plugins/shiki";

const initialMessages: UIMessage[] = [
  {
    id: "1",
    role: "user",
    parts: [{ type: "text", text: "What is Nuxt UI?" }],
  },
  {
    id: "2",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Nuxt UI is a Vue component library built on Reka UI, Tailwind CSS, and Tailwind Variants. It provides 125+ accessible components for building modern web apps.",
      },
    ],
  },
];
const input = ref("");

const { messages, status, error, sendMessage } = useChat({
  messages: initialMessages,
});

function onSubmit() {
  if (!input.value.trim()) return;

  sendMessage({ text: input.value });

  input.value = "";
}

const ui = {
  prose: {
    p: { base: "my-2 leading-6" },
    li: { base: "my-0.5 leading-6" },
    ul: { base: "my-2" },
    ol: { base: "my-2" },
    h1: { base: "text-xl my-2" },
    h2: { base: "text-lg my-2" },
    h3: { base: "text-base my-2" },
    h4: { base: "text-sm my-2" },
    pre: { root: "my-2" },
    table: { root: "my-2" },
    hr: { base: "my-2" },
  },
};
</script>

<template>
  <UModal open :ui="{ content: 'sm:max-w-3xl sm:h-[28rem]' }">
    <template #content>
      <UTheme :ui="ui">
        <UChatPalette>
          <UChatMessages
            :messages="messages"
            :status="status"
            :user="{
              side: 'left',
              variant: 'naked',
              avatar: {
                src: 'https://github.com/benjamincanac.png',
                loading: 'lazy' as const,
              },
            }"
            :assistant="{ icon: 'i-lucide-bot' }"
          >
            <template #content="{ message }">
              <template
                v-for="(part, index) in message.parts"
                :key="`${message.id}-${part.type}-${index}`"
              >
                <template v-if="isTextUIPart(part)">
                  <Markdown
                    v-if="message.role === 'assistant'"
                    :value="part.text"
                    :streaming="isPartStreaming(part)"
                    :plugins="[shiki()]"
                    class="*:first:mt-0 *:last:mb-0"
                  />
                  <p
                    v-else-if="message.role === 'user'"
                    class="whitespace-pre-wrap leading-6"
                  >
                    {{ part.text }}
                  </p>
                </template>
              </template>
            </template>
          </UChatMessages>

          <template #prompt>
            <UChatPrompt
              v-model="input"
              icon="i-lucide-search"
              variant="naked"
              :error="error"
              @submit="onSubmit"
            />
          </template>
        </UChatPalette>
      </UTheme>
    </template>
  </UModal>
</template>
```

### Within ContentSearch

You can use the ChatPalette component conditionally inside [ContentSearch](https://ui.nuxt.com/docs/components/content-search)'s content to display a chatbot interface when a user selects an item.

```vue [ChatPaletteContentSearchExample.vue]
<script setup lang="ts">
import { isTextUIPart } from "ai";
import { useChat } from "@ai-sdk/vue";
import { isPartStreaming } from "@nuxt/ui/utils/ai";
import { Markdown } from "@comark/vue";
import shiki from "@comark/vue/plugins/shiki";

const input = ref("");

const { messages, status, error, sendMessage, regenerate } = useChat();

const groups = computed(() => [
  {
    id: "ai",
    ignoreFilter: true,
    items: [
      {
        label: searchTerm.value ? `Ask AI for “${searchTerm.value}”` : "Ask AI",
        icon: "i-lucide-bot",
        onSelect: (e: any) => {
          e.preventDefault();

          ai.value = true;

          if (searchTerm.value) {
            messages.value = [
              ...messages.value,
              {
                id: "1",
                role: "user",
                parts: [{ type: "text", text: searchTerm.value }],
              },
            ];

            regenerate();
          }
        },
      },
    ],
  },
]);

const ai = ref(false);
const searchTerm = ref("");

function onSubmit() {
  if (!input.value.trim()) return;

  sendMessage({ text: input.value });

  input.value = "";
}

function onClose(e: Event) {
  e.preventDefault();

  ai.value = false;
}

const ui = {
  prose: {
    p: { base: "my-2 leading-6" },
    li: { base: "my-0.5 leading-6" },
    ul: { base: "my-2" },
    ol: { base: "my-2" },
    h1: { base: "text-xl my-2" },
    h2: { base: "text-lg my-2" },
    h3: { base: "text-base my-2" },
    h4: { base: "text-sm my-2" },
    pre: { root: "my-2" },
    table: { root: "my-2" },
    hr: { base: "my-2" },
  },
};
</script>

<template>
  <UContentSearch v-model:search-term="searchTerm" open :groups="groups">
    <template v-if="ai" #content>
      <UTheme :ui="ui">
        <UChatPalette>
          <UChatMessages
            :messages="messages"
            :status="status"
            :user="{
              side: 'left',
              variant: 'naked',
              avatar: {
                src: 'https://github.com/benjamincanac.png',
                loading: 'lazy' as const,
              },
            }"
            :assistant="{ icon: 'i-lucide-bot' }"
          >
            <template #content="{ message }">
              <template
                v-for="(part, index) in message.parts"
                :key="`${message.id}-${part.type}-${index}`"
              >
                <template v-if="isTextUIPart(part)">
                  <Markdown
                    v-if="message.role === 'assistant'"
                    :value="part.text"
                    :streaming="isPartStreaming(part)"
                    :plugins="[shiki()]"
                    class="*:first:mt-0 *:last:mb-0"
                  />
                  <p
                    v-else-if="message.role === 'user'"
                    class="whitespace-pre-wrap leading-6"
                  >
                    {{ part.text }}
                  </p>
                </template>
              </template>
            </template>
          </UChatMessages>

          <template #prompt>
            <UChatPrompt
              v-model="input"
              icon="i-lucide-search"
              variant="naked"
              :error="error"
              @submit="onSubmit"
              @close="onClose"
            />
          </template>
        </UChatPalette>
      </UTheme>
    </template>
  </UContentSearch>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
