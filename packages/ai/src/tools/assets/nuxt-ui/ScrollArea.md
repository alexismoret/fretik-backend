# UScrollArea

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ScrollArea component
 */
interface ScrollAreaProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The scroll direction.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * Array of items to render.
   */
  items?: T[] | undefined;
  /**
   * Enable virtualization for large lists.
   * @default false
   */
  virtualize?: boolean | ScrollAreaVirtualizeOptions | undefined;
  /**
   * Display fade shadows on the scrollable edges to indicate more content.
   * Pass an object to configure the shadow size (in px).
   * @default false
   */
  shadow?: boolean | { size?: number | undefined } | undefined;
  ui?: { root?: SlotClass; viewport?: SlotClass; item?: SlotClass } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ScrollArea component
 */
interface ScrollAreaSlots {
  default(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the ScrollArea component
 */
interface ScrollAreaEmits {
  scroll: (payload: [isScrolling: boolean]) => void;
}
```

### Expose

You can access the typed component instance using [`useTemplateRef`](https://vuejs.org/api/composition-api-helpers.html#usetemplateref){rel="&#x22;nofollow&#x22;"}.

```vue
<script setup lang="ts">
const scrollArea = useTemplateRef("scrollArea");

// Scroll to a specific item
function scrollToItem(index: number) {
  scrollArea.value?.virtualizer?.scrollToIndex(index, { align: "center" });
}
</script>

<template>
  <UScrollArea ref="scrollArea" :items="items" virtualize />
</template>
```

This will give you access to the following:

| Name                                                                                                                              | Type                                                                                                                              | Description                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `$el`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"}         | `HTMLElement`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | The root element of the component.                                                                                             |
| `virtualizer`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<Virtualizer>                                                                                                                 | undefined`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | The [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer){rel="&#x22;nofollow&#x22;"} virtualizer instance (`undefined` if virtualization is disabled). |

## Usage

The ScrollArea component creates scrollable containers with optional virtualization for large lists.

```vue [ScrollAreaExample.vue]
<script setup lang="ts">
const heights = [320, 480, 640, 800];

// Pseudo-random height selection with longer cycle to avoid alignment patterns
function getHeight(index: number) {
  const seed = (index * 11 + 7) % 17;
  return heights[seed % heights.length]!;
}

const items = Array.from({ length: 1000 }).map((_, index) => {
  const height = getHeight(index);

  return {
    id: index,
    title: `Item ${index + 1}`,
    src: `https://picsum.photos/640/${height}?v=${index}`,
    width: 640,
    height,
  };
});
</script>

<template>
  <UScrollArea
    v-slot="{ item, index }"
    :items="items"
    orientation="vertical"
    :virtualize="{
      gap: 16,
      lanes: 3,
      estimateSize: 480,
    }"
    class="w-full h-128 p-4"
  >
    <img
      :src="item.src"
      :alt="item.title"
      :width="item.width"
      :height="item.height"
      :loading="index > 8 ? 'lazy' : 'eager'"
      class="rounded-md size-full object-cover"
    />
  </UScrollArea>
</template>
```

### Items

Use the `items` prop as an array and render each item using the default slot:

```vue [ScrollAreaItemsExample.vue]
<script setup lang="ts">
const items = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  title: `Item ${i + 1}`,
  description: `Description for item ${i + 1}`,
}));
</script>

<template>
  <UScrollArea v-slot="{ item, index }" :items="items" class="w-full h-96">
    <UPageCard
      v-bind="item"
      :variant="index % 2 === 0 ? 'soft' : 'outline'"
      class="rounded-none"
    />
  </UScrollArea>
</template>
```

> \[!TIP]
> See: #with-default-slot
>
> You can also use the default slot without the `items` prop to render custom scrollable content directly.

### Orientation

Use the `orientation` prop to change the scroll direction. Defaults to `vertical`.

```vue [ScrollAreaOrientationExample.vue]
<script setup lang="ts">
defineProps<{
  orientation?: "vertical" | "horizontal";
}>();

const items = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  title: `Item ${i + 1}`,
  description: `Description for item ${i + 1}`,
}));
</script>

<template>
  <UScrollArea
    v-slot="{ item, index }"
    :items="items"
    :orientation="orientation"
    class="w-full data-[orientation=vertical]:h-96"
  >
    <UPageCard
      v-bind="item"
      :variant="index % 2 === 0 ? 'soft' : 'outline'"
      class="rounded-none"
    />
  </UScrollArea>
</template>
```

### Virtualize

Use the `virtualize` prop to render only the items currently in view, significantly boosting performance when working with large datasets.

> \[!NOTE]
>
> When virtualization is **enabled**, customize spacing via the `virtualize` prop options like `gap`, `paddingStart`, and `paddingEnd`. Otherwise, use the `ui` prop to apply classes like `gap p-4` on the `viewport` slot.

> \[!TIP]
>
> If all your items have the **same height**, set `skipMeasurement` to `true` in the `virtualize` prop to skip per-item DOM measurement and rely on `estimateSize` instead. This significantly improves performance for large uniform lists.

```vue [ScrollAreaVirtualizeExample.vue]
<script setup lang="ts">
defineProps<{
  orientation?: "vertical" | "horizontal";
}>();

const items = computed(() =>
  Array.from({ length: 1000 }, (_, i) => ({
    id: i + 1,
    title: `Item ${i + 1}`,
    description: `Description for item ${i + 1}`,
  })),
);
</script>

<template>
  <UScrollArea
    v-slot="{ item, index }"
    :items="items"
    :orientation="orientation"
    virtualize
    class="w-full data-[orientation=vertical]:h-96 data-[orientation=horizontal]:h-24.5"
  >
    <UPageCard
      v-bind="item"
      :variant="index % 2 === 0 ? 'soft' : 'outline'"
      class="rounded-none"
    />
  </UScrollArea>
</template>
```

### Shadow `4.9+`

Use the `shadow` prop to display fade shadows on the scrollable edges, indicating that more content is available in the scroll direction. The fade automatically follows the `orientation` and only appears when the content overflows.

```vue [ScrollAreaShadowExample.vue]
<template>
  <div class="max-w-sm bg-elevated/50 rounded-lg">
    <UScrollArea shadow class="p-4 h-72" :ui="{ viewport: 'gap-4' }">
      <p v-for="i in 6" :key="i">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam pulvinar
        risus non risus hendrerit venenatis. Pellentesque sit amet hendrerit
        risus, sed porttitor quam. Morbi accumsan cursus enim, sed ultricies
        sapien.
      </p>
    </UScrollArea>
  </div>
</template>
```

> \[!TIP]
>
> Pass an object to the `shadow` prop to configure the fade size, e.g. `:shadow="{ size: 48 }"`.

## Examples

### As masonry layout

Use the `virtualize` prop with `lanes`, `gap`, and `estimateSize` options to create Pinterest-style masonry layouts with variable height items.

```vue [ScrollAreaMasonryLayoutExample.vue]
<script setup lang="ts">
withDefaults(
  defineProps<{
    orientation?: "vertical" | "horizontal";
    lanes?: number;
    gap?: number;
  }>(),
  {
    orientation: "vertical",
    lanes: 3,
    gap: 16,
  },
);

const heights = [320, 480, 640, 800];

function getHeight(index: number) {
  const seed = (index * 11 + 7) % 17;
  return heights[seed % heights.length]!;
}

const items = Array.from({ length: 1000 }).map((_, index) => {
  const height = getHeight(index);

  return {
    id: index,
    title: `Item ${index + 1}`,
    src: `https://picsum.photos/640/${height}?v=${index}`,
    width: 640,
    height,
  };
});
</script>

<template>
  <UScrollArea
    v-slot="{ item }"
    :items="items"
    :orientation="orientation"
    :virtualize="{
      gap,
      lanes,
      estimateSize: 480,
    }"
    class="w-full h-128 p-4"
  >
    <img
      :src="item.src"
      :alt="item.title"
      :width="item.width"
      :height="item.height"
      loading="lazy"
      class="rounded-md size-full object-cover"
    />
  </UScrollArea>
</template>
```

> \[!TIP]
>
> For optimal performance, set `estimateSize` close to your average item height. Increasing `overscan` improves scrolling smoothness but renders more off-screen items.

### With responsive lanes

You can use the [`useWindowSize`](https://vueuse.org/core/useWindowSize/){rel="&#x22;nofollow&#x22;"} (for viewport-based) or [`useElementSize`](https://vueuse.org/core/useElementSize/){rel="&#x22;nofollow&#x22;"} (for container-based) composables to make the `lanes` reactive.

```vue [ScrollAreaResponsiveLanesExample.vue]
<script setup lang="ts">
const items = Array.from({ length: 1000 }).map((_, index) => ({
  id: index,
  title: `Item ${index + 1}`,
  src: `https://picsum.photos/640/480?v=${index}`,
  width: 640,
  height: 480,
}));

const gap = 16;
const scrollArea = useTemplateRef("scrollArea");
const { width } = useElementSize(() => scrollArea.value?.$el);

const lanes = computed(() =>
  Math.max(1, Math.min(4, Math.floor(width.value / 200))),
);
const laneWidth = computed(
  () => (width.value - (lanes.value - 1) * gap) / lanes.value,
);
const estimateSize = computed(() => laneWidth.value * (480 / 640));
</script>

<template>
  <UScrollArea
    ref="scrollArea"
    v-slot="{ item }"
    :items="items"
    :virtualize="{
      gap,
      lanes,
      estimateSize,
      skipMeasurement: true,
    }"
    class="w-full h-96 p-4"
  >
    <img
      :src="item.src"
      :alt="item.title"
      :width="item.width"
      :height="item.height"
      loading="lazy"
      class="rounded-md size-full object-cover"
    />
  </UScrollArea>
</template>
```

### With external scroll element `4.10+`

Pass a `getScrollElement` function in the `virtualize` prop to virtualize against an ancestor scroll container instead of the component's own viewport. Set `scrollMargin` to the list's offset from the scroll element's start (e.g. the height of the content above it).

```vue [ScrollAreaExternalScrollExample.vue]
<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    orientation?: "vertical" | "horizontal";
  }>(),
  {
    orientation: "vertical",
  },
);

type User = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  image: string;
};

const { data: users } = useLazyFetch(
  "https://dummyjson.com/users?limit=100&select=firstName,lastName,email,image",
  {
    key: "scroll-area-external-scroll-users",
    transform: (data?: { users: User[] }) => data?.users ?? [],
    default: () => [] as User[],
    server: false,
  },
);

const isHorizontal = computed(() => props.orientation === "horizontal");

// The container owns the scroll; the list virtualizes against it so the header and cards share one scrollbar.
const container = useTemplateRef("container");
const title = useTemplateRef("title");
const toolbar = useTemplateRef("toolbar");
const scrollArea = useTemplateRef("scrollArea");

// Item size along the scroll axis: card width when horizontal, row height when vertical.
const itemSize = computed(() => (isHorizontal.value ? 256 : 88));
const getScrollElement = () => container.value;

// `scrollMargin` is the title's offset along the scroll axis: its width when it sits left of the cards, its height when it sits above them.
const { width: titleWidth, height: titleHeight } = useElementSize(
  title,
  undefined,
  { box: "border-box" },
);
const { height: toolbarHeight } = useElementSize(toolbar, undefined, {
  box: "border-box",
});
const scrollMargin = computed(() =>
  isHorizontal.value
    ? titleWidth.value
    : toolbarHeight.value + titleHeight.value,
);

// Find: jump through the items whose name matches the query (like a find toolbar).
const query = ref("");
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return users.value.reduce<number[]>((acc, user, index) => {
    if (`${user.firstName} ${user.lastName}`.toLowerCase().includes(q))
      acc.push(index);
    return acc;
  }, []);
});
const cursor = ref(0);
const currentMatch = computed(() => matches.value[cursor.value] ?? -1);

function scrollToMatch() {
  if (currentMatch.value < 0) return;
  scrollArea.value?.virtualizer?.scrollToIndex(currentMatch.value, {
    align: "center",
    behavior: "smooth",
  });
}

function step(delta: number) {
  if (!matches.value.length) return;
  cursor.value =
    (cursor.value + delta + matches.value.length) % matches.value.length;
  scrollToMatch();
}

function scrollToStart() {
  container.value?.scrollTo(
    isHorizontal.value
      ? { left: 0, behavior: "smooth" }
      : { top: 0, behavior: "smooth" },
  );
}

// Re-runs on a new query and when `users` resolves, so the first match centers as soon as results arrive.
watch(matches, () => {
  cursor.value = 0;
  scrollToMatch();
});
</script>

<template>
  <div
    ref="container"
    :class="
      isHorizontal ? 'w-full overflow-x-auto' : 'w-full h-128 overflow-y-auto'
    "
  >
    <!-- Vertical: the header sits above the toolbar and scrolls away as you scroll down. -->
    <div
      v-if="!isHorizontal"
      ref="title"
      class="flex items-end justify-between gap-4 p-6 bg-elevated/50"
    >
      <div>
        <h2 class="text-2xl font-bold text-highlighted">Members</h2>
        <p class="text-muted">
          This header scrolls away with the cards, sharing one scrollbar.
        </p>
      </div>
      <UBadge
        color="neutral"
        variant="subtle"
        :label="`${users.length} members`"
      />
    </div>

    <div
      ref="toolbar"
      class="z-10 flex items-center px-6 py-3 border-y border-default bg-elevated/50 backdrop-blur"
      :class="isHorizontal ? 'sticky left-0' : 'sticky top-0'"
    >
      <UFieldGroup>
        <UInput
          v-model="query"
          placeholder="Find a member..."
          icon="i-lucide-search"
          aria-describedby="scroll-area-find-count"
          class="w-64"
          :ui="{ trailing: 'pointer-events-none' }"
        >
          <template #trailing>
            <span
              id="scroll-area-find-count"
              class="text-xs text-muted tabular-nums"
              aria-live="polite"
              role="status"
            >
              {{ matches.length ? cursor + 1 : 0 }}/{{ matches.length }}
            </span>
          </template>
        </UInput>
        <UButton
          :icon="isHorizontal ? 'i-lucide-chevron-left' : 'i-lucide-chevron-up'"
          color="neutral"
          variant="outline"
          aria-label="Previous match"
          :disabled="!matches.length"
          @click="step(-1)"
        />
        <UButton
          :icon="
            isHorizontal ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'
          "
          color="neutral"
          variant="outline"
          aria-label="Next match"
          :disabled="!matches.length"
          @click="step(1)"
        />
      </UFieldGroup>

      <UButton
        :icon="
          isHorizontal
            ? 'i-lucide-arrow-left-to-line'
            : 'i-lucide-arrow-up-to-line'
        "
        color="neutral"
        variant="outline"
        class="ms-auto"
        :label="isHorizontal ? 'Start' : 'Top'"
        @click="scrollToStart"
      />
    </div>

    <!-- Horizontal: the header sits left of the cards (in the row) so it scrolls away with them. -->
    <div :class="isHorizontal && 'flex'">
      <div
        v-if="isHorizontal"
        ref="title"
        class="w-72 shrink-0 flex flex-col justify-center gap-4 p-6 bg-elevated/50 border-r border-default"
      >
        <div>
          <h2 class="text-2xl font-bold text-highlighted">Members</h2>
          <p class="text-muted">
            This header scrolls away with the cards, sharing one scrollbar.
          </p>
        </div>
        <UBadge
          color="neutral"
          variant="subtle"
          class="self-start"
          :label="`${users.length} members`"
        />
      </div>

      <UScrollArea
        ref="scrollArea"
        v-slot="{ item, index }"
        :orientation="orientation"
        :items="users"
        :class="isHorizontal && 'h-48 shrink-0'"
        :virtualize="{
          scrollMargin,
          getScrollElement,
          estimateSize: itemSize,
          skipMeasurement: isHorizontal,
        }"
      >
        <UPageCard
          class="rounded-none h-full"
          :class="[
            isHorizontal && 'w-64',
            index === currentMatch && 'bg-primary/10',
          ]"
        >
          <div
            class="flex gap-3 h-full min-w-0"
            :class="
              isHorizontal
                ? 'flex-col items-center justify-center text-center'
                : 'items-center'
            "
          >
            <UAvatar
              :src="item.image"
              :alt="item.firstName"
              :size="isHorizontal ? '2xl' : 'lg'"
              loading="lazy"
            />
            <div class="min-w-0">
              <p class="font-medium text-highlighted truncate">
                {{ item.firstName }} {{ item.lastName }}
              </p>
              <p class="text-sm text-muted truncate">
                {{ item.email }}
              </p>
            </div>
          </div>
        </UPageCard>
      </UScrollArea>
    </div>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
