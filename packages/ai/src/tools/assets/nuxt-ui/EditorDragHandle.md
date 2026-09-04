# UEditorDragHandle

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the EditorDragHandle component
 */
interface EditorDragHandleProps {
  editor?: Editor;
  /**
   * @default appConfig.ui.icons.drag
   */
  icon?: any;
  /**
   * @default 'neutral'
   */
  color?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  /**
   * @default 'ghost'
   */
  variant?: "ghost" | "solid" | "outline" | "soft" | "subtle" | "link" | undefined;
  /**
   * The options for positioning the drag handle. Those are passed to Floating UI and include options for the placement, offset, flip, shift, size, autoPlacement, hide, and inline middleware.
   * @default { strategy: 'absolute', placement: 'left-start' }
   */
  options?: FloatingUIOptions | undefined;
  ui?: { root?: SlotClass; handle?: SlotClass; } & { base?: SlotClass; label?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailingIcon?: SlotClass; } | undefined;
  pluginKey?: string | PluginKey<any> | undefined;
  nestedOptions?: NormalizedNestedOptions | undefined;
  onElementDragStart?: (e: DragEvent): void | undefined;
  onElementDragEnd?: (e: DragEvent): void | undefined;
  getReferencedVirtualElement?: (): VirtualElement | null | undefined;
  dragImageProperties?: string[] | undefined;
  /**
   * Enable drag handles for nested content (list items, blockquotes, etc.).
   * 
   * When enabled, the drag handle will appear for nested blocks, not just
   * top-level blocks. A rule-based scoring system determines which node
   * to target based on cursor position and configured rules.
   */
  nested?: boolean | NestedOptions | undefined;
  /**
   * Class to apply when the link is exact active
   */
  exactActiveClass?: string | undefined;
  /**
   * Pass the returned promise of `router.push()` to `document.startViewTransition()` if supported.
   */
  viewTransition?: boolean | undefined;
  autofocus?: false | true | "true" | "false" | undefined;
  disabled?: boolean | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  name?: string | undefined;
  /**
   * The type of the button when not a link.
   * @default 'button'
   */
  type?: "reset" | "submit" | "button" | undefined;
  onClick?: (event: MouseEvent): void | ((event: MouseEvent) => void)[] | undefined;
  /**
   * The element or component this component should render as when not a link.
   * @default 'button'
   */
  as?: any;
  label?: string | undefined;
  activeColor?: "error" | "neutral" | "primary" | "secondary" | "success" | "info" | "warning" | undefined;
  activeVariant?: "ghost" | "solid" | "outline" | "soft" | "subtle" | "link" | undefined;
  /**
   * @default 'sm'
   */
  size?: "sm" | "xs" | "md" | "lg" | "xl" | undefined;
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
  /**
   * Display an avatar on the left side.
   */
  avatar?: AvatarProps | undefined;
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
   * When `true`, the loading icon will be displayed.
   */
  loading?: boolean | undefined;
  /**
   * The icon when the `loading` prop is `true`.
   * @default appConfig.ui.icons.loading
   */
  loadingIcon?: any;
}
```

### Slots

```ts
/**
 * Slots for the EditorDragHandle component
 */
interface EditorDragHandleSlots {
  default(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the EditorDragHandle component
 */
interface EditorDragHandleEmits {
  nodeChange: (payload: [{ node: JSONContent; pos: number; }]) => void;
  hover: (payload: [{ node: JSONContent; pos: number; }]) => void;
}
```

## Usage

The EditorDragHandle component provides drag-and-drop functionality for reordering editor blocks using the `@tiptap/extension-drag-handle-vue-3` package.

> [!CAUTION]
> 
> It must be used inside an [Editor](https://ui.nuxt.com/docs/components/editor) component's default slot to have access to the editor instance.

It extends the [Button](https://ui.nuxt.com/docs/components/button) component, so you can pass any property such as `color`, `variant`, `size`, etc.

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

> [!NOTE]
> See: https://tiptap.dev/docs/editor/extensions/functionality/drag-handle-vue
> 
> Learn more about the Drag Handle extension in the TipTap documentation.

### Icon

Use the `icon` prop to customize the drag handle icon.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorDragHandle :editor="editor" icon="i-lucide-move" />
  </UEditor>
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.drag` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.drag` key.

### Options

Use the `options` prop to customize the positioning behavior using [Floating UI options](https://floating-ui.com/docs/computeposition#options).

> [!NOTE]
> 
> The offset is automatically calculated to center the handle for small blocks and align it to the top for taller blocks.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorDragHandle
      :editor="editor"
      :options="{
        placement: 'left'
      }"
    />
  </UEditor>
</template>
```

## Examples

### With dropdown menu

Use the default slot to add a [DropdownMenu](https://ui.nuxt.com/docs/components/dropdown-menu) with block-level actions like duplicate, delete, move up/down, or transform blocks into different types.

Listen to the `@node-change` event to track the currently hovered node and its position, then use `editor.chain().setMeta('lockDragHandle', open).run()` to lock the handle position while the menu is open.

```vue [EditorDragHandleDropdownMenuExample.vue]
<script setup lang="ts">
import { upperFirst } from 'scule'
import type { DropdownMenuItem } from '@nuxt/ui'
import { mapEditorItems } from '@nuxt/ui/utils/editor'
import type { Editor, JSONContent } from '@tiptap/vue-3'

const value = ref(`Hover over the left side to see both drag handle and menu button.

Click the menu to see block actions. Try duplicating or deleting a block.`)

const selectedNode = ref<{ node: JSONContent, pos: number }>()

const items = (editor: Editor): DropdownMenuItem[][] => {
  if (!selectedNode.value?.node?.type) {
    return []
  }

  return mapEditorItems(editor, [[
    {
      type: 'label',
      label: upperFirst(selectedNode.value.node.type)
    },
    {
      label: 'Turn into',
      icon: 'i-lucide-repeat-2',
      children: [
        { kind: 'paragraph', label: 'Paragraph', icon: 'i-lucide-type' },
        { kind: 'heading', level: 1, label: 'Heading 1', icon: 'i-lucide-heading-1' },
        { kind: 'heading', level: 2, label: 'Heading 2', icon: 'i-lucide-heading-2' },
        { kind: 'heading', level: 3, label: 'Heading 3', icon: 'i-lucide-heading-3' },
        { kind: 'heading', level: 4, label: 'Heading 4', icon: 'i-lucide-heading-4' },
        { kind: 'bulletList', label: 'Bullet List', icon: 'i-lucide-list' },
        { kind: 'orderedList', label: 'Ordered List', icon: 'i-lucide-list-ordered' },
        { kind: 'blockquote', label: 'Blockquote', icon: 'i-lucide-text-quote' },
        { kind: 'codeBlock', label: 'Code Block', icon: 'i-lucide-square-code' }
      ]
    },
    {
      kind: 'clearFormatting',
      pos: selectedNode.value?.pos,
      label: 'Reset formatting',
      icon: 'i-lucide-rotate-ccw'
    }
  ], [
    {
      kind: 'duplicate',
      pos: selectedNode.value?.pos,
      label: 'Duplicate',
      icon: 'i-lucide-copy'
    },
    {
      label: 'Copy to clipboard',
      icon: 'i-lucide-clipboard',
      onSelect: async () => {
        if (!selectedNode.value) return

        const pos = selectedNode.value.pos
        const node = editor.state.doc.nodeAt(pos)
        if (node) {
          await navigator.clipboard.writeText(node.textContent)
        }
      }
    }
  ], [
    {
      kind: 'moveUp',
      pos: selectedNode.value?.pos,
      label: 'Move up',
      icon: 'i-lucide-arrow-up'
    },
    {
      kind: 'moveDown',
      pos: selectedNode.value?.pos,
      label: 'Move down',
      icon: 'i-lucide-arrow-down'
    }
  ], [
    {
      kind: 'delete',
      pos: selectedNode.value?.pos,
      label: 'Delete',
      icon: 'i-lucide-trash'
    }
  ]]) as DropdownMenuItem[][]
}
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    class="w-full min-h-19"
  >
    <UEditorDragHandle v-slot="{ ui }" :editor="editor" @node-change="selectedNode = $event">
      <UDropdownMenu
        v-slot="{ open }"
        :modal="false"
        :items="items(editor)"
        :content="{ side: 'left' }"
        :ui="{ content: 'w-48', label: 'text-xs' }"
        @update:open="editor.chain().setMeta('lockDragHandle', $event).run()"
      >
        <UButton
          icon="i-lucide-grip-vertical"
          color="neutral"
          variant="ghost"
          active-variant="soft"
          size="sm"
          :active="open"
          :class="ui.handle()"
        />
      </UDropdownMenu>
    </UEditorDragHandle>
  </UEditor>
</template>
```

> [!NOTE]
> 
> This example uses the `mapEditorItems` utility from `@nuxt/ui/utils/editor` to automatically map handler kinds (like `duplicate`, `delete`, `moveUp`, etc.) to their corresponding editor commands with proper state management.

### With suggestion menu

Use the default slot to add a [Button](https://ui.nuxt.com/docs/components/button) next to the drag handle to open the [EditorSuggestionMenu](https://ui.nuxt.com/docs/components/editor-suggestion-menu).

Call the `onClick` slot function to get the current node position, then use `handlers.suggestion?.execute(editor, { pos: node?.pos }).run()` to insert new blocks at that position.

```vue [EditorDragHandleSuggestionMenuExample.vue]
<script setup lang="ts">
import type { EditorSuggestionMenuItem } from '@nuxt/ui'

const value = ref(`Click the plus button to open the suggestion menu and add new blocks.

The button appears when hovering over blocks.`)

const suggestionItems: EditorSuggestionMenuItem[][] = [[{
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
  kind: 'bulletList',
  label: 'Bullet List',
  icon: 'i-lucide-list'
}, {
  kind: 'blockquote',
  label: 'Blockquote',
  icon: 'i-lucide-text-quote'
}]]
</script>

<template>
  <UEditor
    v-slot="{ editor, handlers }"
    v-model="value"
    content-type="markdown"
    class="w-full min-h-35"
    :ui="{ base: 'p-8 sm:px-16' }"
  >
    <UEditorSuggestionMenu :editor="editor" :items="suggestionItems" />

    <UEditorDragHandle v-slot="{ ui, onClick }" :editor="editor">
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="ghost"
        size="sm"
        :class="ui.handle()"
        @click="(e) => {
          e.stopPropagation()

          const selected = onClick()
          handlers.suggestion?.execute(editor, { pos: selected?.pos }).run()
        }"
      />

      <UButton
        icon="i-lucide-grip-vertical"
        color="neutral"
        variant="ghost"
        size="sm"
        :class="ui.handle()"
      />
    </UEditorDragHandle>
  </UEditor>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
