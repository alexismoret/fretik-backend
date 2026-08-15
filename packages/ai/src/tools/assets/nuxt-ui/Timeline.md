# UTimeline

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Timeline component
 */
interface TimelineProps {
  items: T[];
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'md'
   */
  size?:
    | "3xs"
    | "2xs"
    | "xs"
    | "sm"
    | "md"
    | "lg"
    | "xl"
    | "2xl"
    | "3xl"
    | undefined;
  /**
   * @default 'primary'
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
   * The orientation of the Timeline.
   * @default 'vertical'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * The key used to get the value from the item.
   * @default 'value'
   */
  valueKey?:
    | (keyof Extract<NestedItem<T>, object> & string)
    | DotPathKeys<Extract<NestedItem<T>, object>>
    | undefined;
  defaultValue?: string | number | undefined;
  reverse?: boolean | undefined;
  ui?:
    | {
        root?: SlotClass;
        item?: SlotClass;
        container?: SlotClass;
        indicator?: SlotClass;
        separator?: SlotClass;
        wrapper?: SlotClass;
        date?: SlotClass;
        title?: SlotClass;
        description?: SlotClass;
      }
    | undefined;
  modelValue?: string | number | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Timeline component
 */
interface TimelineSlots {
  indicator(): any;
  wrapper(): any;
  date(): any;
  title(): any;
  description(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Timeline component
 */
interface TimelineEmits {
  select: (payload: [event: Event, item: T]) => void;
  update:modelValue: (payload: [value: string | number | undefined]) => void;
}
```

## Usage

Use the Timeline component to display a list of items in a timeline.

```vue
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items = ref<TimelineItem[]>([
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description:
      "Kicked off the project with team alignment. Set up project milestones and allocated resources.",
    icon: "i-lucide-rocket",
  },
  {
    date: "Mar 22 2025",
    title: "Design Phase",
    description:
      "User research and design workshops. Created wireframes and prototypes for user testing.",
    icon: "i-lucide-palette",
  },
  {
    date: "Mar 29 2025",
    title: "Development Sprint",
    description:
      "Frontend and backend development. Implemented core features and integrated with APIs.",
    icon: "i-lucide-code",
  },
  {
    date: "Apr 5 2025",
    title: "Testing & Deployment",
    description:
      "QA testing and performance optimization. Deployed the application to production.",
    icon: "i-lucide-check-circle",
  },
]);
</script>

<template>
  <UTimeline :items="items" />
</template>
```

### Items

Use the `items` prop as an array of objects with the following properties:

- `date?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `title?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `description?: AvatarProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `icon?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `avatar?: AvatarProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `value?: string | number`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- [`slot?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}](https://ui.nuxt.com/#with-custom-slot)
- `class?: any`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `ui?: { item?: ClassNameValue, container?: ClassNameValue, indicator?: ClassNameValue, separator?: ClassNameValue, wrapper?: ClassNameValue, date?: ClassNameValue, title?: ClassNameValue, description?: ClassNameValue }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

```vue
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items = ref<TimelineItem[]>([
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description:
      "Kicked off the project with team alignment. Set up project milestones and allocated resources.",
    icon: "i-lucide-rocket",
  },
  {
    date: "Mar 22 2025",
    title: "Design Phase",
    description:
      "User research and design workshops. Created wireframes and prototypes for user testing.",
    icon: "i-lucide-palette",
  },
  {
    date: "Mar 29 2025",
    title: "Development Sprint",
    description:
      "Frontend and backend development. Implemented core features and integrated with APIs.",
    icon: "i-lucide-code",
  },
  {
    date: "Apr 5 2025",
    title: "Testing & Deployment",
    description:
      "QA testing and performance optimization. Deployed the application to production.",
    icon: "i-lucide-check-circle",
  },
]);
</script>

<template>
  <UTimeline :default-value="2" :items="items" class="w-96" />
</template>
```

### Color

Use the `color` prop to change the color of the active items in a Timeline.

```vue
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items = ref<TimelineItem[]>([
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description:
      "Kicked off the project with team alignment. Set up project milestones and allocated resources.",
    icon: "i-lucide-rocket",
  },
  {
    date: "Mar 22 2025",
    title: "Design Phase",
    description:
      "User research and design workshops. Created wireframes and prototypes for user testing.",
    icon: "i-lucide-palette",
  },
  {
    date: "Mar 29 2025",
    title: "Development Sprint",
    description:
      "Frontend and backend development. Implemented core features and integrated with APIs.",
    icon: "i-lucide-code",
  },
  {
    date: "Apr 5 2025",
    title: "Testing & Deployment",
    description:
      "QA testing and performance optimization. Deployed the application to production.",
    icon: "i-lucide-check-circle",
  },
]);
</script>

<template>
  <UTimeline color="neutral" :default-value="2" :items="items" class="w-96" />
</template>
```

### Size

Use the `size` prop to change the size of the Timeline.

```vue
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items = ref<TimelineItem[]>([
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description:
      "Kicked off the project with team alignment. Set up project milestones and allocated resources.",
    icon: "i-lucide-rocket",
  },
  {
    date: "Mar 22 2025",
    title: "Design Phase",
    description:
      "User research and design workshops. Created wireframes and prototypes for user testing.",
    icon: "i-lucide-palette",
  },
  {
    date: "Mar 29 2025",
    title: "Development Sprint",
    description:
      "Frontend and backend development. Implemented core features and integrated with APIs.",
    icon: "i-lucide-code",
  },
  {
    date: "Apr 5 2025",
    title: "Testing & Deployment",
    description:
      "QA testing and performance optimization. Deployed the application to production.",
    icon: "i-lucide-check-circle",
  },
]);
</script>

<template>
  <UTimeline size="xs" :default-value="2" :items="items" class="w-96" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the Timeline. Defaults to `vertical`.

```vue
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items = ref<TimelineItem[]>([
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description: "Kicked off the project with team alignment.",
    icon: "i-lucide-rocket",
  },
  {
    date: "Mar 22 2025",
    title: "Design Phase",
    description: "User research and design workshops.",
    icon: "i-lucide-palette",
  },
  {
    date: "Mar 29 2025",
    title: "Development Sprint",
    description: "Frontend and backend development.",
    icon: "i-lucide-code",
  },
  {
    date: "Apr 5 2025",
    title: "Testing & Deployment",
    description: "QA testing and performance optimization.",
    icon: "i-lucide-check-circle",
  },
]);
</script>

<template>
  <UTimeline
    orientation="horizontal"
    :default-value="2"
    :items="items"
    class="w-full"
  />
</template>
```

### Reverse

Use the reverse prop to reverse the direction of the Timeline.

```vue
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items = ref<TimelineItem[]>([
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description: "Kicked off the project with team alignment.",
    icon: "i-lucide-rocket",
  },
  {
    date: "Mar 22 2025",
    title: "Design Phase",
    description: "User research and design workshops.",
    icon: "i-lucide-palette",
  },
  {
    date: "Mar 29 2025",
    title: "Development Sprint",
    description: "Frontend and backend development.",
    icon: "i-lucide-code",
  },
  {
    date: "Apr 5 2025",
    title: "Testing & Deployment",
    description: "QA testing and performance optimization.",
    icon: "i-lucide-check-circle",
  },
]);
</script>

<template>
  <UTimeline
    reverse
    v-model="value"
    orientation="vertical"
    :items="items"
    class="w-full"
  />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### Control active item

You can control the active item by using the `default-value` prop or the `v-model` directive with the `value` of the item. If no `value` is provided, it defaults to the index.

```vue [TimelineModelValueExample.vue]
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items: TimelineItem[] = [
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description:
      "Kicked off the project with team alignment. Set up project milestones and allocated resources.",
    icon: "i-lucide-rocket",
    value: "kickoff",
  },
  {
    date: "Mar 22, 2025",
    title: "Design Phase",
    description:
      "User research and design workshops. Created wireframes and prototypes for user testing.",
    icon: "i-lucide-palette",
    value: "design",
  },
  {
    date: "Mar 29, 2025",
    title: "Development Sprint",
    description:
      "Frontend and backend development. Implemented core features and integrated with APIs.",
    icon: "i-lucide-code",
    value: "development",
  },
  {
    date: "Apr 5, 2025",
    title: "Testing & Deployment",
    description:
      "QA testing and performance optimization. Deployed the application to production.",
    icon: "i-lucide-check-circle",
    value: "deployment",
  },
];

const active = ref(0);

// Note: This is for demonstration purposes only. Don't do this at home.
onMounted(() => {
  setInterval(() => {
    active.value = (active.value + 1) % items.length;
  }, 2000);
});
</script>

<template>
  <UTimeline v-model="active" :items="items" class="w-96" />
</template>
```

> \[!TIP]
>
> Use the `value-key` prop to change the key used to match items when a `v-model` or `default-value` is provided.

### With select event

You can add a `@select` listener to make items clickable.

> \[!NOTE]
>
> The handler function receives the `Event` and `TimelineItem` as the first and second arguments respectively.

```vue [TimelineSelectExample.vue]
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items: TimelineItem[] = [
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    description:
      "Kicked off the project with team alignment. Set up project milestones and allocated resources.",
    icon: "i-lucide-rocket",
    value: "kickoff",
  },
  {
    date: "Mar 22, 2025",
    title: "Design Phase",
    description:
      "User research and design workshops. Created wireframes and prototypes for user testing.",
    icon: "i-lucide-palette",
    value: "design",
  },
  {
    date: "Mar 29, 2025",
    title: "Development Sprint",
    description:
      "Frontend and backend development. Implemented core features and integrated with APIs.",
    icon: "i-lucide-code",
    value: "development",
  },
  {
    date: "Apr 5, 2025",
    title: "Testing & Deployment",
    description:
      "QA testing and performance optimization. Deployed the application to production.",
    icon: "i-lucide-check-circle",
    value: "deployment",
  },
];

const active = ref<string | number>("kickoff");

function onSelect(_e: Event, item: TimelineItem) {
  if (item.value) {
    active.value = item.value;
  }
}
</script>

<template>
  <UTimeline v-model="active" :items="items" class="w-96" @select="onSelect" />
</template>
```

### With alternating layout

Use the `ui` prop to create a Timeline with alternating layout.

```vue [TimelineAlternatingLayoutExample.vue]
<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";

const items: TimelineItem[] = [
  {
    date: "Mar 15, 2025",
    title: "Project Kickoff",
    icon: "i-lucide-rocket",
    value: "kickoff",
  },
  {
    date: "Mar 22, 2025",
    title: "Design Phase",
    icon: "i-lucide-palette",
    value: "design",
  },
  {
    date: "Mar 29, 2025",
    title: "Development Sprint",
    icon: "i-lucide-code",
    value: "development",
  },
  {
    date: "Apr 5, 2025",
    title: "Testing & Deployment",
    icon: "i-lucide-check-circle",
    value: "deployment",
  },
];
</script>

<template>
  <UTimeline
    :items="items"
    :default-value="2"
    :ui="{
      item: 'even:flex-row-reverse even:-translate-x-[calc(100%-2rem)] rtl:even:translate-x-[calc(100%-2rem)] even:text-end',
    }"
    class="translate-x-[calc(50%-1rem)] rtl:-translate-x-[calc(50%-1rem)]"
  />
</template>
```

### With custom slot

Use the `slot` property to customize a specific item.

You will have access to the following slots:

- `#{{ item.slot }}-indicator`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `#{{ item.slot }}-date`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `#{{ item.slot }}-title`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

_(truncated — ask for fewer components to see more, or rely on the API block above)_
