# UEditorSuggestionMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the EditorSuggestionMenu component
 */
interface EditorSuggestionMenuProps {
  /**
   * @default 'md'
   */
  size?: "xs" | "md" | "sm" | "lg" | "xl" | undefined;
  items?: T[] | T[][] | undefined;
  ui?: { content?: SlotClass; viewport?: SlotClass; group?: SlotClass; label?: SlotClass; separator?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; itemLabelExternalIcon?: SlotClass; } | undefined;
  editor?: Editor;
  /**
   * The trigger character (e.g., '/', '@', ':')
   * @default '/'
   */
  char?: string | undefined;
  /**
   * Plugin key to identify this menu
   * @default 'suggestionMenu'
   */
  pluginKey?: string | undefined;
  /**
   * Fields to filter items by.
   * @default ['label']
   */
  filterFields?: string[] | undefined;
  /**
   * Maximum number of items to display
   * @default 42
   */
  limit?: number | undefined;
  /**
   * The options for positioning the menu. Those are passed to Floating UI and include options for the placement, offset, flip, shift, size, autoPlacement, hide, and inline middleware.
   * @default { strategy: 'absolute', placement: 'bottom-start', offset: 8, shift: { padding: 8 } }
   */
  options?: FloatingUIOptions | undefined;
  /**
   * Optional TipTap Suggestion matching options.
   */
  suggestion?: Omit<Partial<SuggestionOptions<any, any>>, "editor" | "char" | "pluginKey" | "items" | "command" | "render"> | undefined;
  /**
   * The DOM element to append the menu to. Default is the editor's parent element.
   * 
   * Sometimes the menu needs to be appended to a different DOM context due to accessibility, clipping, or z-index issues.
   */
  appendTo?: HTMLElement | (): HTMLElement | undefined;
}
```

## Usage

The EditorSuggestionMenu component displays a menu of formatting and action suggestions when typing a trigger character in the editor and executes the corresponding [handler](https://ui.nuxt.com/docs/components/editor#handlers) when an item is selected.

> [!NOTE]
> 
> It uses the `useEditorMenu` composable built on top of TipTap's [Suggestion](https://tiptap.dev/docs/editor/api/utilities/suggestion) utility to filter items as you type and support keyboard navigation (arrow keys, enter to select, escape to close).

> [!CAUTION]
> 
> It must be used inside an [Editor](https://ui.nuxt.com/docs/components/editor) component's default slot to have access to the editor instance.

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

### Items

Use the `items` prop as an array of objects with the following properties:

- [`kind?: "textAlign" | "heading" | "link" | "image" | "blockquote" | "bulletList" | "orderedList" | "taskList" | "codeBlock" | "horizontalRule" | "paragraph" | "clearFormatting" | "duplicate" | "delete" | "moveUp" | "moveDown" | "suggestion" | "mention" | "emoji"`](https://ui.nuxt.com/docs/components/editor#handlers)
- `label?: string`
- `description?: string`
- `icon?: string`
- `type?: "label" | "separator"`
- `disabled?: boolean`

```vue [EditorSuggestionMenuItemsExample.vue]
<script setup lang="ts">
import type { EditorSuggestionMenuItem } from '@nuxt/ui'

const value = ref(`Type / to see a list of commands.

You can customize the items with icons, labels, and descriptions.`)

const items: EditorSuggestionMenuItem[][] = [[{
  type: 'label',
  label: 'Text Styles'
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
  label: 'Blocks'
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
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    placeholder="Type / for commands..."
    class="w-full min-h-19"
  >
    <UEditorSuggestionMenu :editor="editor" :items="items" />
  </UEditor>
</template>
```

> [!NOTE]
> 
> You can also pass an array of arrays to the `items` prop to create separated groups of items.

> [!TIP]
> 
> Use `type: 'label'` for section headers and `type: 'separator'` for visual dividers to organize commands into logical groups for better discoverability.

### Char

Use the `char` prop to change the trigger character. Defaults to `/`.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorSuggestionMenu :editor="editor" :items="items" char=">" />
  </UEditor>
</template>
```

### Suggestion `4.7+`

Use the `suggestion` prop to customize TipTap's [Suggestion matching behavior](https://tiptap.dev/docs/editor/api/utilities/suggestion#settings).

This is useful when the trigger character should open directly after other characters instead of requiring the default whitespace prefix.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorSuggestionMenu
      :editor="editor"
      :items="items"
      char=":"
      :suggestion="{
        allowedPrefixes: null
      }"
    />
  </UEditor>
</template>
```

### Options

Use the `options` prop to customize the positioning behavior using [Floating UI options](https://floating-ui.com/docs/computeposition#options).

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorSuggestionMenu
      :editor="editor"
      :items="items"
      :options="{
        placement: 'bottom-start',
        offset: 4
      }"
    />
  </UEditor>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
