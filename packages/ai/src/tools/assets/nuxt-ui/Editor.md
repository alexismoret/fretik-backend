# UEditor

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Editor component
 */
interface EditorProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  modelValue?: null | string | JSONContent | JSONContent[];
  /**
   * The content type the content is provided as.
   * When not specified, it's automatically inferred: strings are treated as 'html', objects as 'json'.
   */
  contentType?: "markdown" | "json" | "html" | undefined;
  /**
   * The starter kit options to configure the editor.
   * Set to `false` for a plain-text editor: keeps the essential nodes (paragraph, text, history) and disables all rich-text formatting.
   * @default true
   */
  starterKit?: boolean | Partial<StarterKitOptions> | undefined;
  /**
   * The placeholder text to show in empty paragraphs. Can be a string or PlaceholderOptions from `@tiptap/extension-placeholder`.
   * @default { showOnlyWhenEditable: false, showOnlyCurrent: true, mode: 'everyLine' }
   */
  placeholder?: string | Partial<PlaceholderOptions> & { mode?: "firstLine" | "everyLine" | undefined; } | undefined;
  /**
   * The markdown extension options to configure markdown parsing and serialization.
   * @default { markedOptions: { gfm: true } }
   */
  markdown?: Partial<MarkdownExtensionOptions> | undefined;
  /**
   * The image extension options to configure image handling. Set to `false` to disable the extension.
   * @default true
   */
  image?: boolean | Partial<ImageOptions> | undefined;
  /**
   * The mention extension options to configure mention handling. Set to `false` to disable the extension.
   * The `suggestion` and `suggestions` options are omitted as they are managed by the `EditorMentionMenu` component.
   * @default true
   */
  mention?: boolean | Partial<Omit<MentionOptions<any, MentionNodeAttrs>, "suggestion" | "suggestions">> | undefined;
  /**
   * Custom item handlers to override or extend the default handlers.
   * These handlers are provided to all child components (toolbar, suggestion menu, etc.).
   */
  handlers?: H | undefined;
  ui?: { root?: SlotClass; content?: SlotClass; base?: SlotClass; } | undefined;
  /**
   * The extensions to use
   */
  extensions?: Extensions | undefined;
  /**
   * Whether to inject base CSS styles
   */
  injectCSS?: boolean | undefined;
  /**
   * A nonce to use for CSP while injecting styles
   */
  injectNonce?: string | undefined;
  /**
   * The editor's initial focus position
   */
  autofocus?: null | number | false | true | "start" | "end" | "all" | undefined;
  /**
   * Whether the editor is editable
   */
  editable?: boolean | undefined;
  /**
   * The default text direction for all content in the editor.
   * When set to 'ltr' or 'rtl', all nodes will have the corresponding dir attribute.
   * When set to 'auto', the dir attribute will be set based on content detection.
   * When undefined, no dir attribute will be added.
   */
  textDirection?: "ltr" | "rtl" | "auto" | undefined;
  /**
   * The editor's props
   */
  editorProps?: EditorProps<any> | undefined;
  parseOptions?: ParseOptions;
  /**
   * The editor's core extension options
   */
  coreExtensionOptions?: { clipboardTextSerializer?: { blockSeparator?: string | undefined; } | undefined; tabindex?: { value?: string | undefined; } | undefined; delete?: { async?: boolean | undefined; filterTransaction?: ((transaction: Transaction) => boolean) | undefined; } | undefined; } | undefined;
  /**
   * Whether to enable input rules behavior
   */
  enableInputRules?: false | true | (string | AnyExtension)[] | undefined;
  /**
   * Whether to enable paste rules behavior
   */
  enablePasteRules?: false | true | (string | AnyExtension)[] | undefined;
  /**
   * Determines whether core extensions are enabled.
   * 
   * If set to `false`, all core extensions will be disabled.
   * To disable specific core extensions, provide an object where the keys are the extension names and the values are `false`.
   * Extensions not listed in the object will remain enabled.
   */
  enableCoreExtensions?: boolean | Partial<Record<"editable" | "textDirection" | "clipboardTextSerializer" | "commands" | "focusEvents" | "keymap" | "tabindex" | "drop" | "paste" | "delete", false>> | undefined;
  /**
   * If `true`, the editor will check the content for errors on initialization.
   * Emitting the `contentError` event if the content is invalid.
   * Which can be used to show a warning or error message to the user.
   */
  enableContentCheck?: boolean | undefined;
  /**
   * If `true`, the editor will emit the `contentError` event if invalid content is
   * encountered but `enableContentCheck` is `false`. This lets you preserve the
   * invalid editor content while still showing a warning or error message to
   * the user.
   */
  emitContentError?: boolean | undefined;
  /**
   * Called before the editor is constructed.
   */
  onBeforeCreate?: (props: { editor: Editor; }): void | undefined;
  /**
   * Called after the editor is constructed.
   */
  onCreate?: (props: { editor: Editor; }): void | undefined;
  /**
   * Called when the editor is mounted.
   */
  onMount?: (props: { editor: Editor; }): void | undefined;
  /**
   * Called when the editor is unmounted.
   */
  onUnmount?: (props: { editor: Editor; }): void | undefined;
  /**
   * Called when the editor encounters an error while parsing the content.
   * Only enabled if `enableContentCheck` is `true`.
   */
  onContentError?: (props: { editor: Editor; error: Error; disableCollaboration: () => void; }): void | undefined;
  /**
   * Called when the editor's content is updated.
   */
  onUpdate?: (props: { editor: Editor; transaction: Transaction; appendedTransactions: Transaction[]; }): void | undefined;
  /**
   * Called when the editor's selection is updated.
   */
  onSelectionUpdate?: (props: { editor: Editor; transaction: Transaction; }): void | undefined;
  /**
   * Called after a transaction is applied to the editor.
   */
  onTransaction?: (props: { editor: Editor; transaction: Transaction; appendedTransactions: Transaction[]; }): void | undefined;
  /**
   * Called on focus events.
   */
  onFocus?: (props: { editor: Editor; event: FocusEvent; transaction: Transaction; }): void | undefined;
  /**
   * Called on blur events.
   */
  onBlur?: (props: { editor: Editor; event: FocusEvent; transaction: Transaction; }): void | undefined;
  /**
   * Called when the editor is destroyed.
   */
  onDestroy?: (props: void): void | undefined;
  /**
   * Called when content is pasted into the editor.
   */
  onPaste?: (e: ClipboardEvent, slice: Slice): void | undefined;
  /**
   * Called when content is dropped into the editor.
   */
  onDrop?: (e: DragEvent, slice: Slice, moved: boolean): void | undefined;
  /**
   * Called when content is deleted from the editor.
   */
  onDelete?: (props: { editor: Editor; deletedRange: Range; newRange: Range; transaction: Transaction; combinedTransform: Transform; partial: boolean; from: number; to: number; } & ({ ...; } | { ...; })): void | undefined;
  /**
   * Whether to enable extension-level dispatching of transactions.
   * If `false`, extensions cannot define their own `dispatchTransaction` hook.
   */
  enableExtensionDispatchTransaction?: boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Editor component
 */
interface EditorSlots {
  default(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Editor component
 */
interface EditorEmits {
  update:modelValue: (payload: [value: T]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name | Type |
| --- | --- |
| `editor` | `Ref<Editor \| undefined>` |

> [!NOTE]
> See: https://tiptap.dev/docs/editor/api/editor
> 
> The exposed editor instance is the TipTap Editor API. Check the TipTap documentation for all available methods and properties.

## Composition

Also written in the docs and absent from the interface above — one per column or item: `#leading`.

## Usage

The Editor component provides a powerful rich text editing experience built on [TipTap](https://tiptap.dev/). It supports multiple content formats (JSON, HTML, Markdown), customizable toolbars, drag-and-drop block reordering, slash commands, mentions, emoji picker, and extensible architecture for adding custom functionality.

```vue [EditorExample.vue]
<script setup lang="ts">
import type { EditorCustomHandlers, EditorToolbarItem, EditorSuggestionMenuItem, EditorMentionMenuItem, EditorEmojiMenuItem, DropdownMenuItem } from '@nuxt/ui'
import type { Editor, JSONContent } from '@tiptap/vue-3'
import { upperFirst } from 'scule'
import { mapEditorItems } from '@nuxt/ui/utils/editor'
import { Emoji, gitHubEmojis } from '@tiptap/extension-emoji'
import { TextAlign } from '@tiptap/extension-text-align'
import { CodeBlockShiki } from 'tiptap-extension-code-block-shiki'
import { ImageUpload } from './EditorImageUploadExtension'
import { useEditorCompletion } from './EditorUseCompletion'
import EditorLinkPopover from './EditorLinkPopover.vue'

const editorRef = useTemplateRef('editorRef')

const value = ref(`# Building Modern Interfaces with Nuxt UI

Welcome to the **Nuxt UI Editor** — a powerful rich text editing experience built on [TipTap](https://tiptap.dev). This editor combines *flexibility* with ease of use, making content creation a breeze.

![Placeholder](/placeholder.jpeg)

## Examples

> [!NOTE]
> See: https://github.com/nuxt-ui-templates/editor
> 
> Check out the source code of our **Editor template** on GitHub for a real-life example.

### With toolbar

You can use the [EditorToolbar](https://ui.nuxt.com/docs/components/editor-toolbar) component to add a `fixed`, `bubble`, or `floating` toolbar to the Editor with common formatting actions.

```vue [EditorToolbarExample.vue]
<script setup lang="ts">
import type { EditorToolbarItem } from '@nuxt/ui'

const value = ref(`# Toolbar

Select some text to see the formatting toolbar appear above your selection.`)

const items: EditorToolbarItem[][] = [[{
  icon: 'i-lucide-heading',
  tooltip: { text: 'Headings' },
  content: {
    align: 'start'
  },
  items: [{
    kind: 'heading',
    level: 1,
    icon: 'i-lucide-heading-1',
    label: 'Heading 1'
  }, {
    kind: 'heading',
    level: 2,
    icon: 'i-lucide-heading-2',
    label: 'Heading 2'
  }, {
    kind: 'heading',
    level: 3,
    icon: 'i-lucide-heading-3',
    label: 'Heading 3'
  }, {
    kind: 'heading',
    level: 4,
    icon: 'i-lucide-heading-4',
    label: 'Heading 4'
  }]
}], [{
  kind: 'mark',
  mark: 'bold',
  icon: 'i-lucide-bold',
  tooltip: { text: 'Bold' }
}, {
  kind: 'mark',
  mark: 'italic',
  icon: 'i-lucide-italic',
  tooltip: { text: 'Italic' }
}, {
  kind: 'mark',
  mark: 'underline',
  icon: 'i-lucide-underline',
  tooltip: { text: 'Underline' }
}, {
  kind: 'mark',
  mark: 'strike',
  icon: 'i-lucide-strikethrough',
  tooltip: { text: 'Strikethrough' }
}, {
  kind: 'mark',
  mark: 'code',
  icon: 'i-lucide-code',
  tooltip: { text: 'Code' }
}]]
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    class="w-full min-h-21"
  >
    <UEditorToolbar :editor="editor" :items="items" layout="bubble" />
  </UEditor>
</template>
```

### With drag handle

You can use the [EditorDragHandle](https://ui.nuxt.com/docs/components/editor-drag-handle) component to add a draggable handle for reordering blocks.

```vue [EditorDragHandleExample.vue]
<script setup lang="ts">
const value = ref(`# Drag Handle

Hover over the left side of this block to see the drag handle appear and reorder blocks.`)
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    class="w-full min-h-21"
  >
    <UEditorDragHandle :editor="editor" />
  </UEditor>
</template>
```

### With suggestion menu

You can use the [EditorSuggestionMenu](https://ui.nuxt.com/docs/components/editor-suggestion-menu) component to add slash commands for quick formatting and insertions.

```vue [EditorSuggestionMenuExample.vue]
<script setup lang="ts">
import type { EditorSuggestionMenuItem } from '@nuxt/ui'

const value = ref(`# Suggestion Menu

Type / to open the suggestion menu and browse available formatting commands.`)

const items: EditorSuggestionMenuItem[][] = [[{
  type: 'label',
  label: 'Text'
}, {
  kind: 'paragraph',
  label: 'Paragraph',
  icon: 'i-lucide-type'
}, {
  kind: 'heading',
  level: 1,
  label: 'Heading 1',
  icon: 'i-lucide-heading-1'
}, {
  kind: 'heading',
  level: 2,
  label: 'Heading 2',
  icon: 'i-lucide-heading-2'
}, {
  kind: 'heading',
  level: 3,
  label: 'Heading 3',
  icon: 'i-lucide-heading-3'
}], [{
  type: 'label',
  label: 'Lists'
}, {
  kind: 'bulletList',
  label: 'Bullet List',
  icon: 'i-lucide-list'
}, {
  kind: 'orderedList',
  label: 'Numbered List',
  icon: 'i-lucide-list-ordered'
}], [{
  type: 'label',
  label: 'Insert'
}, {
  kind: 'blockquote',
  label: 'Blockquote',
  icon: 'i-lucide-text-quote'
}, {
  kind: 'codeBlock',
  label: 'Code Block',
  icon: 'i-lucide-square-code'
}, {
  kind: 'horizontalRule',
  label: 'Divider',
  icon: 'i-lucide-separator-horizontal'
}]]

// SSR-safe function to append menus to body (avoids z-index issues in docs)
const appendToBody = false ? () => document.body : undefined
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    placeholder="Type / for commands..."
    class="w-full min-h-21"
  >
    <UEditorSuggestionMenu :editor="editor" :items="items" :append-to="appendToBody" />
  </UEditor>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
