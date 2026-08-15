# UEditorEmojiMenu

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the EditorEmojiMenu component
 */
interface EditorEmojiMenuProps {
  /**
   * @default 'md'
   */
  size?: "xs" | "md" | "sm" | "lg" | "xl" | undefined;
  items?: T[] | T[][] | undefined;
  ui?: { content?: SlotClass; viewport?: SlotClass; group?: SlotClass; label?: SlotClass; separator?: SlotClass; item?: SlotClass; itemLeadingIcon?: SlotClass; itemLeadingAvatar?: SlotClass; itemLeadingAvatarSize?: SlotClass; itemWrapper?: SlotClass; itemLabel?: SlotClass; itemDescription?: SlotClass; itemLabelExternalIcon?: SlotClass; } | undefined;
  editor?: Editor;
  /**
   * The trigger character (e.g., '/', '@', ':')
   * @default ':'
   */
  char?: string | undefined;
  /**
   * Plugin key to identify this menu
   * @default 'emojiMenu'
   */
  pluginKey?: string | undefined;
  /**
   * Fields to filter items by.
   * @default ["name", "shortcodes", "tags"]
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

The EditorEmojiMenu component displays a menu of emoji suggestions when typing the `:` character in the editor and inserts the selected emoji. It works alongside the `@tiptap/extension-emoji` package to provide emoji support.

> \[!NOTE]
>
> It uses the `useEditorMenu` composable built on top of TipTap's [Suggestion](https://tiptap.dev/docs/editor/api/utilities/suggestion){rel="&#x22;nofollow&#x22;"} utility to filter items as you type and support keyboard navigation (arrow keys, enter to select, escape to close).

> \[!CAUTION]
>
> It must be used inside an [Editor](https://ui.nuxt.com/docs/components/editor) component's default slot to have access to the editor instance.

```vue [EditorEmojiMenuExample.vue]
<script setup lang="ts">
import type { EditorEmojiMenuItem } from "@nuxt/ui";
import { Emoji, gitHubEmojis } from "@tiptap/extension-emoji";

const value = ref(`# Emoji Menu

Type : to insert emojis and select from the list of available emojis.`);

const items: EditorEmojiMenuItem[] = gitHubEmojis.filter(
  (emoji) => !emoji.name.startsWith("regional_indicator_"),
);

// SSR-safe function to append menus to body (avoids z-index issues in docs)
const appendToBody = import.meta.client ? () => document.body : undefined;
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    :extensions="[Emoji]"
    content-type="markdown"
    placeholder="Type : to add emojis..."
    class="w-full min-h-21"
  >
    <UEditorEmojiMenu
      :editor="editor"
      :items="items"
      :append-to="appendToBody"
    />
  </UEditor>
</template>
```

> \[!WARNING]
>
> The `@tiptap/extension-emoji` package is not installed by default, you need to install it separately.

> \[!NOTE]
> See: https\://tiptap.dev/docs/editor/extensions/nodes/emoji
>
> Learn more about the Emoji extension in the TipTap documentation.

### Items

Use the `items` prop as an array of objects with the following properties:

- `name: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `emoji: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `shortcodes?: string[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `tags?: string[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `group?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `fallbackImage?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue [EditorEmojiMenuItemsExample.vue]
<script setup lang="ts">
import type { EditorEmojiMenuItem } from "@nuxt/ui";
import { Emoji } from "@tiptap/extension-emoji";

const value = ref(`Type : to see a custom emoji set.

You can also install the \`@tiptap/extension-emoji\` extension to use a comprehensive set with over 1800 emojis.`);

const items: EditorEmojiMenuItem[] = [
  {
    name: "smile",
    emoji: "😄",
    shortcodes: ["smile"],
    tags: ["happy", "joy", "pleased"],
  },
  {
    name: "heart",
    emoji: "❤️",
    shortcodes: ["heart"],
    tags: ["love", "like"],
  },
  {
    name: "thumbsup",
    emoji: "👍",
    shortcodes: ["thumbsup", "+1"],
    tags: ["approve", "ok"],
  },
  {
    name: "fire",
    emoji: "🔥",
    shortcodes: ["fire"],
    tags: ["hot", "burn"],
  },
  {
    name: "rocket",
    emoji: "🚀",
    shortcodes: ["rocket"],
    tags: ["ship", "launch"],
  },
  {
    name: "eyes",
    emoji: "👀",
    shortcodes: ["eyes"],
    tags: ["look", "watch"],
  },
  {
    name: "tada",
    emoji: "🎉",
    shortcodes: ["tada"],
    tags: ["party", "celebration"],
  },
  {
    name: "thinking",
    emoji: "🤔",
    shortcodes: ["thinking"],
    tags: ["hmm", "think", "consider"],
  },
];
</script>

<template>
  <UEditor
    v-slot="{ editor }"
    v-model="value"
    :extensions="[Emoji]"
    content-type="markdown"
    placeholder="Type : to add emojis..."
    class="w-full min-h-26"
  >
    <UEditorEmojiMenu :editor="editor" :items="items" />
  </UEditor>
</template>
```

> \[!NOTE]
>
> You can also pass an array of arrays to the `items` prop to create separated groups of items.

### Char

Use the `char` prop to change the trigger character. Defaults to `:`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorEmojiMenu :editor="editor" :items="items" char=";" />
  </UEditor>
</template>
```

### Suggestion `4.7+`

Use the `suggestion` prop to customize TipTap's [Suggestion matching behavior](https://tiptap.dev/docs/editor/api/utilities/suggestion#settings){rel="&#x22;nofollow&#x22;"}.

This is useful when the trigger character should open directly after other characters instead of requiring the default whitespace prefix.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorEmojiMenu
      :editor="editor"
      :items="items"
      :suggestion="{
        allowedPrefixes: null,
      }"
    />
  </UEditor>
</template>
```

### Options

Use the `options` prop to customize the positioning behavior using [Floating UI options](https://floating-ui.com/docs/computeposition#options){rel="&#x22;nofollow&#x22;"}.

```vue
<template>
  <UEditor v-slot="{ editor }">
    <UEditorEmojiMenu
      :editor="editor"
      :items="items"
      :options="{
        placement: 'bottom-start',
        offset: 4,
      }"
    />
  </UEditor>
</template>
```
