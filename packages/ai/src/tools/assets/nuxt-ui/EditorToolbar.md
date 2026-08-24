# UEditorToolbar

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the EditorToolbar component
 */
interface EditorToolbarProps {
  editor?: Editor;
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The color of the toolbar controls.
   * @default 'neutral'
   */
  color?:
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | "error"
    | "neutral"
    | undefined;
  /**
   * The variant of the toolbar controls.
   * @default 'ghost'
   */
  variant?:
    "solid" | "outline" | "soft" | "subtle" | "ghost" | "link" | undefined;
  /**
   * The color of the active toolbar control.
   * @default 'primary'
   */
  activeColor?:
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | "error"
    | "neutral"
    | undefined;
  /**
   * The variant of the active toolbar control.
   * @default 'soft'
   */
  activeVariant?:
    "solid" | "outline" | "soft" | "subtle" | "ghost" | "link" | undefined;
  /**
   * The size of the toolbar controls.
   * @default 'sm'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  items?: T | undefined;
  ui?:
    | {
        root?: SlotClass;
        base?: SlotClass;
        group?: SlotClass;
        separator?: SlotClass;
      }
    | undefined;
  /**
   * @default 'fixed'
   */
  layout?: "fixed" | "floating" | "bubble" | undefined;
  /**
   * The plugin key.
   * The plugin key for the floating menu.
   */
  pluginKey?: unknown;
  /**
   * The delay in milliseconds before the menu should be updated.
   * This can be useful to prevent performance issues.
   */
  updateDelay?: unknown;
  /**
   * The delay in milliseconds before the menu position should be updated on window resize.
   * This can be useful to prevent performance issues.
   */
  resizeDelay?: unknown;
  /**
   * A function that determines whether the menu should be shown or not.
   * If this function returns `false`, the menu will be hidden, otherwise it will be shown.
   */
  shouldShow?: unknown;
  /**
   * The DOM element to append your menu to. Default is the editor's parent element.
   *
   * Sometimes the menu needs to be appended to a different DOM context due to accessibility, clipping, or z-index issues.
   */
  appendTo?: unknown;
  /**
   * A function that returns the virtual element for the menu.
   * This is useful when the menu needs to be positioned relative to a specific DOM element.
   */
  getReferencedVirtualElement?: unknown;
  /**
   * The options for the bubble menu. Those are passed to Floating UI and include options for the placement, offset, flip, shift, arrow, size, autoPlacement,
   * hide, and inline middlewares.
   * The options for the floating menu. Those are passed to Floating UI and include options for the placement, offset, flip, shift, arrow, size, autoPlacement,
   * hide, and inline middlewares.
   */
  options?: unknown;
}
```

### Slots

```ts
/**
 * Slots for the EditorToolbar component
 */
interface EditorToolbarSlots {
  item(): any;
}
```

## Usage

The EditorToolbar component displays a toolbar of formatting buttons that automatically sync their active state with the editor content. It supports three layout modes using the `@tiptap/vue-3/menus` package:

- `fixed`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} (always visible)
- `bubble`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} (appears on text selection)
- `floating`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} (appears on empty lines)

> \[!CAUTION]
>
> It must be used inside an [Editor](https://ui.nuxt.com/docs/components/editor) component's default slot to have access to the editor instance.

```vue [EditorToolbarExample.vue]
<script setup lang="ts">
import type { EditorToolbarItem } from "@nuxt/ui";

const value = ref(`# Toolbar

Select some text to see the formatting toolbar appear above your selection.`);

const items: EditorToolbarItem[][] = [
  [
    {
      icon: "i-lucide-heading",
      tooltip: { text: "Headings" },
      content: {
        align: "start",
      },
      items: [
        {
          kind: "heading",
          level: 1,
          icon: "i-lucide-heading-1",
          label: "Heading 1",
        },
        {
          kind: "heading",
          level: 2,
          icon: "i-lucide-heading-2",
          label: "Heading 2",
        },
        {
          kind: "heading",
          level: 3,
          icon: "i-lucide-heading-3",
          label: "Heading 3",
        },
        {
          kind: "heading",
          level: 4,
          icon: "i-lucide-heading-4",
          label: "Heading 4",
        },
      ],
    },
  ],
  [
    {
      kind: "mark",
      mark: "bold",
      icon: "i-lucide-bold",
      tooltip: { text: "Bold" },
    },
    {
      kind: "mark",
      mark: "italic",
      icon: "i-lucide-italic",
      tooltip: { text: "Italic" },
    },
    {
      kind: "mark",
      mark: "underline",
      icon: "i-lucide-underline",
      tooltip: { text: "Underline" },
    },
    {
      kind: "mark",
      mark: "strike",
      icon: "i-lucide-strikethrough",
      tooltip: { text: "Strikethrough" },
    },
    {
      kind: "mark",
      mark: "code",
      icon: "i-lucide-code",
      tooltip: { text: "Code" },
    },
  ],
];
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

> \[!NOTE]
>
> The bubble and floating layouts use TipTap's [BubbleMenu](https://tiptap.dev/docs/editor/extensions/functionality/bubble-menu){rel="&#x22;nofollow&#x22;"} and [FloatingMenu](https://tiptap.dev/docs/editor/extensions/functionality/floatingmenu){rel="&#x22;nofollow&#x22;"} extensions.

### Items

Use the `items` prop as an array of objects with the following properties:

- `label?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `activeColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `variant?: "solid" | "outline" | "soft" | "ghost" | "link" | "subtle"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `activeVariant?: "solid" | "outline" | "soft" | "ghost" | "link" | "subtle"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `size?: "xs" | "sm" | "md" | "lg" | "xl"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`kind?: "mark" | "textAlign" | "heading" | "link" | "image" | "blockquote" | "bulletList" | "orderedList" | "taskList" | "codeBlock" | "horizontalRule" | "paragraph" | "undo" | "redo" | "clearFormatting" | "duplicate" | "delete" | "moveUp" | "moveDown" | "suggestion" | "mention" | "emoji"`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/docs/components/editor#handlers)
- `disabled?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `loading?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `active?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `tooltip?: TooltipProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-link-popover)
- `onClick?: (e: MouseEvent) => void`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `items?: EditorToolbarItem[] | EditorToolbarItem[][]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

You can pass any property from the [Button](https://ui.nuxt.com/docs/components/button#props) component such as `color`, `variant`, `size`, etc.

```vue [EditorToolbarItemsExample.vue]
<script setup lang="ts">
import type { EditorToolbarItem } from "@nuxt/ui";
import { TextAlign } from "@tiptap/extension-text-align";

const value =
  ref(`This toolbar showcases **all available formatting options** using built-in handlers. Try the different controls to see them in action!

You can apply **bold**, *italic*, <u>underline</u>, ~~strikethrough~~, and \`inline code\` formatting to your text.
`);

const items: EditorToolbarItem[][] = [
  // History controls
  [
    {
      kind: "undo",
      icon: "i-lucide-undo",
      tooltip: { text: "Undo" },
    },
    {
      kind: "redo",
      icon: "i-lucide-redo",
      tooltip: { text: "Redo" },
    },
  ],
  // Block types
  [
    {
      icon: "i-lucide-heading",
      tooltip: { text: "Headings" },
      content: {
        align: "start",
      },
      items: [
        {
          kind: "heading",
          level: 1,
          icon: "i-lucide-heading-1",
          label: "Heading 1",
        },
        {
          kind: "heading",
          level: 2,
          icon: "i-lucide-heading-2",
          label: "Heading 2",
        },
        {
          kind: "heading",
          level: 3,
          icon: "i-lucide-heading-3",
          label: "Heading 3",
        },
        {
          kind: "heading",
          level: 4,
          icon: "i-lucide-heading-4",
          label: "Heading 4",
        },
      ],
    },
    {
      icon: "i-lucide-list",
      tooltip: { text: "Lists" },
      content: {
        align: "start",
      },
      items: [
        {
          kind: "bulletList",
          icon: "i-lucide-list",
          label: "Bullet List",
        },
        {
          kind: "orderedList",
          icon: "i-lucide-list-ordered",
          label: "Ordered List",
        },
      ],
    },
    {
      kind: "blockquote",
      icon: "i-lucide-text-quote",
      tooltip: { text: "Blockquote" },
    },
    {
      kind: "codeBlock",
      icon: "i-lucide-square-code",
      tooltip: { text: "Code Block" },
    },
    {
      kind: "horizontalRule",
      icon: "i-lucide-separator-horizontal",
      tooltip: { text: "Horizontal Rule" },
    },
  ],
  // Text formatting
  [
    {
      kind: "mark",
      mark: "bold",
      icon: "i-lucide-bold",
      tooltip: { text: "Bold" },
    },
    {
      kind: "mark",
      mark: "italic",
      icon: "i-lucide-italic",
      tooltip: { text: "Italic" },
    },
    {
      kind: "mark",
      mark: "underline",
      icon: "i-lucide-underline",
      tooltip: { text: "Underline" },
    },
    {
      kind: "mark",
      mark: "strike",
      icon: "i-lucide-strikethrough",
      tooltip: { text: "Strikethrough" },
    },
    {
      kind: "mark",
      mark: "code",
      icon: "i-lucide-code",
      tooltip: { text: "Code" },
    },
  ],
  // Link
  [
    {
      kind: "link",
      icon: "i-lucide-link",
      tooltip: { text: "Link" },
    },
  ],
  // Text alignment
  [
    {
      icon: "i-lucide-align-justify",
      tooltip: { text: "Text Align" },
      content: {
        align: "end",
      },
      items: [
        {
          kind: "textAlign",
          align: "left",
          icon: "i-lucide-align-left",
          label: "Align Left",
        },
        {
          kind: "textAlign",
          align: "center",
          icon: "i-lucide-align-center",
          label: "Align Center",
        },
        {
          kind: "textAlign",
          align: "right",
          icon: "i-lucide-align-right",
          label: "Align Right",
        },
        {
          kind: "textAlign",
          align: "justify",
          icon: "i-lucide-align-justify",
          label: "Align Justify",
        },
      ],
    },
  ],
];
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    :extensions="[TextAlign.configure({ types: ['heading', 'paragraph'] })]"
    class="w-full min-h-37 flex flex-col gap-4"
  >
    <UEditorToolbar
      :editor="editor"
      :items="items"
      class="sm:px-8 overflow-x-auto"
    />
  </UEditor>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With image toolbar

Use the `should-show` prop to create context-specific toolbars that appear only for certain node types. This example shows a `bubble` toolbar with download and delete actions that only appears when an image is selected.

```vue [EditorToolbarImageExample.vue]
<script setup lang="ts">
import type { Editor } from "@tiptap/vue-3";
import type { EditorToolbarItem } from "@nuxt/ui";

const value = ref(`Click on the image below to see the image-specific toolbar:

![Image Placeholder](/placeholder.jpeg)`);

const items = (editor: Editor): EditorToolbarItem[][] => {
  const node = editor.state.doc.nodeAt(editor.state.selection.from);

  return [
    [
      {
        icon: "i-lucide-download",
        to: node?.attrs?.src,
        download: true,
        tooltip: { text: "Download" },
      },
    ],
    [
      {
        icon: "i-lucide-trash",
        tooltip: { text: "Delete" },
        onClick: () => {
          const { state } = editor;
          const { selection } = state;

          const pos = selection.from;
          const node = state.doc.nodeAt(pos);

          if (node && node.type.name === "image") {
            editor
              .chain()
              .focus()
              .deleteRange({ from: pos, to: pos + node.nodeSize })
              .run();
          }
        },
      },
    ],
  ];
};
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    content-type="markdown"
    class="w-full min-h-113"
  >
    <UEditorToolbar
      :editor="editor"
      :items="items(editor)"
      layout="bubble"
      :should-show="
        ({ editor, view }) => {
          return editor.isActive('image') && view.hasFocus();
        }
      "
    />
  </UEditor>
</template>
```

### With link popover

This example demonstrates how to create a custom link popover using the `slot` property on toolbar items and the [Popover](https://ui.nuxt.com/docs/components/popover) component.

1. Create a Vue component that wraps a [Popover](https://ui.nuxt.com/docs/components/popover) with link editing functionality:

```vue [EditorLinkPopover.vue]
<script setup lang="ts">
import type { Editor } from "@tiptap/vue-3";

const props = defineProps<{
  editor: Editor;
  autoOpen?: boolean;
}>();

const open = ref(false);
const url = ref("");

const active = computed(() => props.editor.isActive("link"));
const disabled = computed(() => {
  if (!props.editor.isEditable) return true;
  const { selection } = props.editor.state;
  return selection.empty && !props.editor.isActive("link");
});

watch(
  () => props.editor,
  (editor, _, onCleanup) => {
    if (!editor) return;

    const updateUrl = () => {
      const { href } = editor.getAttributes("link");
      url.value = href || "";
    };

    updateUrl();
    editor.on("selectionUpdate", updateUrl);

    onCleanup(() => {
      editor.off("selectionUpdate", updateUrl);
    });
  },
  { immediate: true },
);

watch(active, (isActive) => {
  if (isActive && props.autoOpen) {
    open.value = true;
  }
});

function setLink() {
  if (!url.value) return;

  const { selection } = props.editor.state;
  const isEmpty = selection.empty;
  const hasCode = props.editor.isActive("code");

  let chain = props.editor.chain().focus();

  // When linking code, extend the code mark range first to select the full code
  if (hasCode && !isEmpty) {
    chain = chain.extendMarkRange("code").setLink({ href: url.value });
  } else {
    chain = chain.extendMarkRange("link").setLink({ href: url.value });

    if (isEmpty) {
      chain = chain.insertContent({ type: "text", text: url.value });
    }
  }

  chain.run();
  open.value = false;
}

function removeLink() {
  props.editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .unsetLink()
    .setMeta("preventAutolink", true)
    .run();

  url.value = "";
  open.value = false;
}

function openLink() {
  if (!url.value) return;
  window.open(url.value, "_blank", "noopener,noreferrer");
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    setLink();
  }
}
</script>

<template>
  <UPopover v-model:open="open" :ui="{ content: 'p-0.5' }">
    <UTooltip text="Link">
      <UButton
        icon="i-lucide-link"
        color="neutral"
        active-color="primary"
        variant="ghost"
        active-variant="soft"
        size="sm"
        :active="active"
        :disabled="disabled"
      />
    </UTooltip>

    <template #content>
      <UInput
        v-model="url"
        autofocus
        name="url"
        type="url"
        variant="none"
        placeholder="Paste a link..."
        @keydown="handleKeyDown"
      >
        <div class="flex items-center mr-0.5">
          <UButton
            icon="i-lucide-corner-down-left"
            variant="ghost"
            size="sm"
            :disabled="!url && !active"
            title="Apply link"
            @click="setLink"
          />

          <USeparator orientation="vertical" class="h-6 mx-1" />

          <UButton
            icon="i-lucide-external-link"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="!url && !active"
            title="Open in new window"
            @click="openLink"
          />

          <UButton
            icon="i-lucide-trash"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="!url && !active"
            title="Remove link"
            @click="removeLink"
          />
        </div>
      </UInput>
    </template>
  </UPopover>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
