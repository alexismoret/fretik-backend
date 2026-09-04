# UChatPrompt

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatPrompt component
 */
interface ChatPromptProps {
  /**
   * The element or component this component should render as.
   * @default 'form'
   */
  as?: any;
  /**
   * The placeholder text for the textarea.
   * @default t('chatPrompt.placeholder')
   */
  placeholder?: string | undefined;
  /**
   * @default 'primary'
   */
  color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "naked" | undefined;
  /**
   * When `true`, pressing `Enter` submits and `Shift+Enter` inserts a newline.
   * When `false`, pressing `Enter` inserts a newline and `Ctrl+Enter` / `Cmd+Enter` submits.
   * @default true
   */
  submitOnEnter?: boolean | undefined;
  error?: Error | undefined;
  ui?: { root?: SlotClass; header?: SlotClass; body?: SlotClass; footer?: SlotClass; base?: SlotClass; } & { root?: SlotClass; base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; } | undefined;
  /**
   * @default 1
   */
  rows?: number | undefined;
  /**
   * @default true
   */
  autofocus?: boolean | undefined;
  autofocusDelay?: number | undefined;
  /**
   * @default true
   */
  autoresize?: boolean | undefined;
  autoresizeDelay?: number | undefined;
  maxrows?: number | undefined;
  /**
   * Display an icon based on the `leading` and `trailing` props.
   */
  icon?: any;
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
  /**
   * @default ''
   */
  modelValue?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/textarea#attributes
> 
> This component also supports all native `<textarea>` HTML attributes.

### Slots

```ts
/**
 * Slots for the ChatPrompt component
 */
interface ChatPromptSlots {
  header(): any;
  footer(): any;
  /**
   * Replace the internal textarea, e.g. to render an [Editor](/docs/components/editor) with mentions.
   */
  body(): any;
  leading(): any;
  default(): any;
  trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the ChatPrompt component
 */
interface ChatPromptEmits {
  close: (payload: [event: Event]) => void;
  submit: (payload: [event: Event]) => void;
  update:modelValue: (payload: [value: string]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `textareaRef` | `Ref<HTMLTextAreaElement \| null>` |

## Composition

Parts placed by name: `#body`.

## Usage

The ChatPrompt component renders a `<form>` element and extends the [Textarea](https://ui.nuxt.com/docs/components/textarea) component so you can pass any property such as `icon`, `placeholder`, `autofocus`, etc.

```vue [ChatPromptExample.vue]
<script setup lang="ts">
import type { SelectItem } from '@nuxt/ui'

const input = ref('')
const model = ref('claude-opus-4.6')

const models = [
  { label: 'Claude Opus 4.6', value: 'claude-opus-4.6', icon: 'i-simple-icons-anthropic' },
  { label: 'Gemini 3 Pro', value: 'gemini-3-pro', icon: 'i-simple-icons-googlegemini' },
  { label: 'GPT-5', value: 'gpt-5', icon: 'i-simple-icons-openai' }
] satisfies SelectItem[]

function onSubmit() {
  input.value = ''
}
</script>

<template>
  <UChatPrompt v-model="input" class="w-full" @submit="onSubmit">
    <template #footer>
      <UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="sm" />

      <div class="flex items-center gap-1.5">
        <USelect
          v-model="model"
          :items="models"
          :icon="models.find(item => item.value === model)?.icon"
          placeholder="Select a model"
          variant="ghost"
          size="sm"
          square
        />

        <UChatPromptSubmit size="sm" />
      </div>
    </template>
  </UChatPrompt>
</template>
```

> [!NOTE]
> 
> The ChatPrompt handles the following events:
> 
> - The form is submitted when the user presses `Enter` or when the user clicks on the submit button. Set the `submit-on-enter` prop to `false` to submit with `Ctrl` + `Enter` (or `Cmd` + `Enter` on macOS) instead, allowing `Enter` to insert a newline.
> - The textarea is blurred when `Esc` is pressed and emits a `close` event.

### Variant

Use the `variant` prop to change the style of the prompt. Defaults to `outline`.

```vue
<template>
  <UChatPrompt variant="soft" />
</template>
```

## Examples

> [!TIP]
> See: /docs/components/chat
> 
> Check the **Chat** overview page for installation instructions, server setup and usage examples.

### With an Editor `4.10+`

Compose the `#header`, `#body` and `#footer` slots to build a rich prompt: file attachments, an [Editor](https://ui.nuxt.com/docs/components/editor) with `@` mentions and `/` commands through [EditorMentionMenu](https://ui.nuxt.com/docs/components/editor-mention-menu), and a mode selector.

```vue [ChatPromptEditorExample.vue]
<script setup lang="ts">
import { Extension } from '@tiptap/core'
import type { EditorMentionMenuItem, SelectItem } from '@nuxt/ui'

const input = ref('')
const mode = ref('auto')
const attachments = ref<{ name: string, src?: string }[]>([])
const fileInputRef = useTemplateRef('fileInputRef')

const files: EditorMentionMenuItem[] = [
  { label: 'app.vue', icon: 'i-vscode-icons-file-type-vue' },
  { label: 'nuxt.config.ts', icon: 'i-vscode-icons-file-type-nuxt' },
  { label: 'package.json', icon: 'i-vscode-icons-file-type-json' },
  { label: 'README.md', icon: 'i-vscode-icons-file-type-markdown' },
  { label: 'AuthForm.vue', icon: 'i-vscode-icons-file-type-vue' },
  { label: 'useChat.ts', icon: 'i-vscode-icons-file-type-typescript' }
]

const commands: EditorMentionMenuItem[] = [
  { label: 'init', icon: 'i-lucide-sparkles' },
  { label: 'review', icon: 'i-lucide-search-code' },
  { label: 'security-review', icon: 'i-lucide-shield-check' },
  { label: 'clear', icon: 'i-lucide-eraser' },
  { label: 'compact', icon: 'i-lucide-fold-vertical' },
  { label: 'config', icon: 'i-lucide-settings' }
]

const modes = [
  { label: 'Manual', value: 'manual', icon: 'i-lucide-hand' },
  { label: 'Edit automatically', value: 'edit', icon: 'i-lucide-code-xml' },
  { label: 'Plan mode', value: 'plan', icon: 'i-lucide-list-checks' },
  { label: 'Auto mode', value: 'auto', icon: 'i-lucide-zap' }
] satisfies SelectItem[]

// SSR-safe target so the menus aren't clipped by overflow
const appendToBody = false ? () => document.body : undefined

function onFilesChange(event: Event) {
  const target = event.target as HTMLInputElement
  for (const file of Array.from(target.files ?? [])) {
    attachments.value.push({
      name: file.name,
      src: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
    })
  }
  target.value = ''
}

function onSubmit() {
  console.log('submit', input.value)

  input.value = ''
  attachments.value = []
}
</script>

<template>
  <UChatPrompt
    v-model="input"
    class="w-full p-0 gap-0"
    placeholder="Press / to open the command menu"
    :ui="{
      header: 'px-2.5 py-2 border-b border-default',
      footer: 'px-2.5 py-2 border-t border-default'
    }"
    @submit="onSubmit"
  >
    <template v-if="attachments.length" #header>
      <UButton
        v-for="(file, index) in attachments"
        :key="index"
        :label="file.name"
        :avatar="file.src ? { src: file.src } : undefined"
        :icon="file.src ? undefined : 'i-lucide-file'"
        color="neutral"
        variant="soft"
        size="xs"
        square
        trailing-icon="i-lucide-x"
        @click="attachments.splice(index, 1)"
      />
    </template>

    <template #body="{ submit, placeholder }">
      <UEditor
        v-slot="{ editor }"
        v-model="input"
        content-type="markdown"
        :starter-kit="false"
        :placeholder="placeholder"
        class="w-full min-h-12"
        :ui="{ base: 'p-2.5! [&_.mention]:bg-primary/5 [&_.mention]:rounded-sm [&_.mention]:px-0.5 [&_.mention]:py-0.25' }"
        :extensions="[Extension.create({
          name: 'chatPromptSubmit',
          priority: 1000,
          addKeyboardShortcuts: () => ({ Enter: () => (submit(), true) })
        })]"
      >
        <UEditorMentionMenu :editor="editor" char="@" plugin-key="mention" :items="files" :append-to="appendToBody" />
        <UEditorMentionMenu :editor="editor" char="/" plugin-key="command" :items="commands" :append-to="appendToBody" />
      </UEditor>
    </template>

    <template #footer>
      <div class="flex items-center gap-0.5">
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          aria-label="Attach files"
          size="sm"
          @click="fileInputRef?.click()"
        />
        <input ref="fileInputRef" type="file" multiple class="hidden" @change="onFilesChange">
      </div>

      <div class="flex items-center gap-1">
        <USelect
          v-model="mode"
          :items="modes"
          :icon="modes.find(item => item.value === mode)?.icon"
          color="neutral"
          variant="ghost"
          size="sm"
          square
        />

        <UChatPromptSubmit size="sm" :disabled="!input.trim()" />
      </div>
    </template>
  </UChatPrompt>
</template>
```

> [!NOTE]
> 
> The `#body` slot replaces the internal textarea and exposes `submit` and `close` handlers, so you can wire the editor's keyboard shortcuts to the form. When a mention menu is open, pressing `Enter` selects the highlighted item instead of submitting.

### As home page

You can also use it in your chat interface home page.

```vue [pages/index.vue]
<script setup lang="ts">
import { useChat } from '@ai-sdk/vue'

const input = ref('')

const { messages, status, sendMessage } = useChat()

async function onSubmit() {
  sendMessage({ text: input.value })

  // Navigate to chat page after first message
  if (messages.value.length === 1) {
    await navigateTo('/chat')
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #body>
      <UContainer>
        <h1>How can I help you today?</h1>

        <UChatPrompt v-model="input" @submit="onSubmit">
          <UChatPromptSubmit :status="status" />
        </UChatPrompt>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
