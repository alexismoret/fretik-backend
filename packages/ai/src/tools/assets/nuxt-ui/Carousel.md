# UCarousel

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Carousel component
 */
interface CarouselProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Configure the prev button when arrows are enabled.
   * @default { size: 'md', color: 'neutral', variant: 'link' }
   */
  prev?: Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the prev button.
   * @default appConfig.ui.icons.arrowLeft
   */
  prevIcon?: any;
  /**
   * Configure the next button when arrows are enabled.
   * @default { size: 'md', color: 'neutral', variant: 'link' }
   */
  next?: Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon displayed in the next button.
   * @default appConfig.ui.icons.arrowRight
   */
  nextIcon?: any;
  /**
   * Display prev and next buttons to scroll the carousel.
   * @default false
   */
  arrows?: boolean | undefined;
  /**
   * Display dots to scroll to a specific slide.
   * @default false
   */
  dots?: boolean | undefined;
  /**
   * The orientation of the carousel.
   * @default 'horizontal'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  items?: T[] | undefined;
  /**
   * Enable Autoplay plugin
   * @default false
   */
  autoplay?: boolean | Partial<CreateOptionsType<OptionsType>> | undefined;
  /**
   * Enable Auto Scroll plugin
   * @default false
   */
  autoScroll?: boolean | Partial<CreateOptionsType<OptionsType>> | undefined;
  /**
   * Enable Auto Height plugin
   * @default false
   */
  autoHeight?: boolean | Partial<CreateOptionsType<{ active: boolean; breakpoints: { [key: string]: Omit<Partial<any>, "breakpoints">; }; }>> | undefined;
  /**
   * Enable Class Names plugin
   * @default false
   */
  classNames?: boolean | Partial<CreateOptionsType<OptionsType>> | undefined;
  /**
   * Enable Fade plugin
   * @default false
   */
  fade?: boolean | Partial<CreateOptionsType<{ active: boolean; breakpoints: { [key: string]: Omit<Partial<any>, "breakpoints">; }; }>> | undefined;
  /**
   * Enable Wheel Gestures plugin
   * @default false
   */
  wheelGestures?: boolean | WheelGesturesPluginOptions | undefined;
  ui?: { root?: SlotClass; viewport?: SlotClass; container?: SlotClass; item?: SlotClass; controls?: SlotClass; arrows?: SlotClass; prev?: SlotClass; next?: SlotClass; dots?: SlotClass; dot?: SlotClass; } | undefined;
  /**
   * @default 'center'
   */
  align?: "start" | "center" | "end" | (viewSize: number, snapSize: number, index: number): number | undefined;
  /**
   * @default 'trimSnaps'
   */
  containScroll?: false | "trimSnaps" | "keepSnaps" | undefined;
  /**
   * @default 1
   */
  slidesToScroll?: number | "auto" | undefined;
  /**
   * @default false
   */
  dragFree?: boolean | undefined;
  /**
   * @default 10
   */
  dragThreshold?: number | undefined;
  /**
   * @default 0
   */
  inViewThreshold?: number | number[] | undefined;
  /**
   * @default false
   */
  loop?: boolean | undefined;
  /**
   * @default false
   */
  skipSnaps?: boolean | undefined;
  /**
   * @default 25
   */
  duration?: number | undefined;
  /**
   * @default 0
   */
  startIndex?: number | undefined;
  /**
   * @default true
   */
  watchDrag?: false | true | (emblaApi: EmblaCarouselType, evt: PointerEventType): boolean | void | undefined;
  /**
   * @default true
   */
  watchResize?: false | true | (emblaApi: EmblaCarouselType, entries: ResizeObserverEntry[]): boolean | void | undefined;
  /**
   * @default true
   */
  watchSlides?: false | true | (emblaApi: EmblaCarouselType, mutations: MutationRecord[]): boolean | void | undefined;
  /**
   * @default true
   */
  watchFocus?: false | true | (emblaApi: EmblaCarouselType, evt: FocusEvent): boolean | void | undefined;
  /**
   * @default true
   */
  active?: boolean | undefined;
  /**
   * @default {}
   */
  breakpoints?: { [key: string]: Omit<Partial<CreateOptionsType<{ align: AlignmentOptionType; axis: AxisOptionType; container: string | HTMLElement | null; slides: string | HTMLElement[] | NodeListOf<HTMLElement> | null; containScroll: ScrollContainOptionType; direction: AxisDirectionOptionType; slidesToScroll: SlidesToScrollOptionType; dragFree: boolean; dragThreshold: number; inViewThreshold: number | number[] | undefined; loop: boolean; skipSnaps: boolean; duration: number; startIndex: number; watchDrag: DragHandlerOptionType; watchResize: ResizeHandlerOptionType; watchSlides: SlidesHandlerOptionType; watchFocus: FocusHandlerOptionType; }>>, "breakpoints">; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Carousel component
 */
interface CarouselSlots {
  default(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Carousel component
 */
interface CarouselEmits {
  select: (payload: [selectedIndex: number]) => void;
}
```

### Expose

You can access the typed component instance using [`useTemplateRef`](https://vuejs.org/api/composition-api-helpers.html#usetemplateref).

```vue
<script setup lang="ts">
const carousel = useTemplateRef('carousel')
</script>

<template>
  <UCarousel ref="carousel" />
</template>
```

This will give you access to the following:

| Name | Type |
| --- | --- |
| `emblaRef` | `Ref<HTMLElement \| null>` |
| `emblaApi` | [`Ref<EmblaCarouselType \| null>`](https://www.embla-carousel.com/docs/v8/api/methods#typescript) |

## Usage

Use the Carousel component to display a list of items in a carousel.

```vue [CarouselExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]
</script>

<template>
  <UCarousel
    v-slot="{ item }"
    loop
    arrows
    :autoplay="{ delay: 2000 }"
    wheel-gestures
    :prev="{ variant: 'solid' }"
    :next="{ variant: 'solid' }"
    :items="items"
    :ui="{
      item: 'basis-1/3 ps-0',
      prev: 'sm:start-8',
      next: 'sm:end-8',
      container: 'ms-0'
    }"
  >
    <img :src="item" width="320" height="320">
  </UCarousel>
</template>
```

> [!NOTE]
> 
> Use your mouse to drag the carousel horizontally on desktop.

### Items

Use the `items` prop as an array and render each item using the default slot:

```vue [CarouselItemsExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]
</script>

<template>
  <UCarousel v-slot="{ item }" :items="items" class="w-full max-w-xs mx-auto">
    <img :src="item" width="320" height="320" class="rounded-lg" loading="lazy">
  </UCarousel>
</template>
```

You can also pass an array of objects with the following properties:

- `class?: any`
- `ui?: { item?: ClassNameValue }`

You can control how many items are visible by using the [`basis`](https://tailwindcss.com/docs/flex-basis) / [`width`](https://tailwindcss.com/docs/width) utility classes on the `item`:

```vue [CarouselItemsMultipleExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/468/468?random=1',
  'https://picsum.photos/468/468?random=2',
  'https://picsum.photos/468/468?random=3',
  'https://picsum.photos/468/468?random=4',
  'https://picsum.photos/468/468?random=5',
  'https://picsum.photos/468/468?random=6'
]
</script>

<template>
  <UCarousel v-slot="{ item }" :items="items" :ui="{ item: 'basis-1/3' }">
    <img :src="item" width="234" height="234" class="rounded-lg" loading="lazy">
  </UCarousel>
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the Progress. Defaults to `horizontal`.

> [!NOTE]
> 
> Use your mouse to drag the carousel vertically on desktop.

```vue [CarouselOrientationExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]
</script>

<template>
  <UCarousel
    v-slot="{ item }"
    orientation="vertical"
    :items="items"
    :ui="{ container: 'h-[336px]' }"
    class="w-full max-w-xs mx-auto"
  >
    <img :src="item" width="320" height="320" class="rounded-lg" loading="lazy">
  </UCarousel>
</template>
```

> [!CAUTION]
> 
> You need to specify a `height` on the container in vertical orientation.

### Arrows

Use the `arrows` prop to display prev and next buttons.

```vue [CarouselArrowsExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]
</script>

<template>
  <UCarousel v-slot="{ item }" arrows :items="items" class="w-full max-w-xs mx-auto">
    <img :src="item" width="320" height="320" class="rounded-lg" loading="lazy">
  </UCarousel>
</template>
```

### Prev / Next

Use the `prev` and `next` props to customize the prev and next buttons with any [Button](https://ui.nuxt.com/docs/components/button) props.

```vue [CarouselPrevNextExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]
</script>

<template>
  <UCarousel
    v-slot="{ item }"
    arrows
    :prev="{ color: 'primary' }"
    :next="{ variant: 'solid' }"
    :items="items"
    class="w-full max-w-xs mx-auto"
  >
    <img :src="item" width="320" height="320" class="rounded-lg" loading="lazy">
  </UCarousel>
</template>
```

### Prev / Next Icons

Use the `prev-icon` and `next-icon` props to customize the buttons [Icon](https://ui.nuxt.com/docs/components/icon). Defaults to `i-lucide-arrow-left` / `i-lucide-arrow-right`.

```vue [CarouselPrevNextIconExample.vue]
<script setup lang="ts">
defineProps<{
  prevIcon?: string
  nextIcon?: string
}>()

const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]
</script>

<template>
  <UCarousel
    v-slot="{ item }"
    arrows
    :prev-icon="prevIcon"
    :next-icon="nextIcon"
    :items="items"
    class="w-full max-w-xs mx-auto"
  >
    <img :src="item" width="320" height="320" class="rounded-lg" loading="lazy">
  </UCarousel>
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize these icons globally in your `app.config.ts` under `ui.icons.arrowLeft` / `ui.icons.arrowRight` key.

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With thumbnails

You can use the [`scrollTo`](https://www.embla-carousel.com/docs/v8/api/methods#scrollto) method on [`emblaApi`](#expose) to display thumbnails under the carousel that navigate to a specific slide.

```vue [CarouselThumbnailsExample.vue]
<script setup lang="ts">
const items = [
  'https://picsum.photos/640/640?random=1',
  'https://picsum.photos/640/640?random=2',
  'https://picsum.photos/640/640?random=3',
  'https://picsum.photos/640/640?random=4',
  'https://picsum.photos/640/640?random=5',
  'https://picsum.photos/640/640?random=6'
]

const carousel = useTemplateRef('carousel')
const activeIndex = ref(0)

function onClickPrev() {
  activeIndex.value--
}
function onClickNext() {
  activeIndex.value++
}
function onSelect(index: number) {
  activeIndex.value = index
}

function select(index: number) {
  activeIndex.value = index

  carousel.value?.emblaApi?.scrollTo(index)
}
</script>

<template>
  <div class="flex-1 w-full">
    <UCarousel
      ref="carousel"
      v-slot="{ item }"
      arrows
      :items="items"
      :prev="{ onClick: onClickPrev }"
      :next="{ onClick: onClickNext }"
      class="w-full max-w-xs mx-auto"
      @select="onSelect"
    >
      <img :src="item" width="320" height="320" class="rounded-lg" loading="lazy">
    </UCarousel>

    <div class="flex gap-1 justify-between pt-4 max-w-xs mx-auto">
      <div
        v-for="(item, index) in items"
        :key="index"
        class="size-11 opacity-25 hover:opacity-100 transition-opacity"
        :class="{ 'opacity-100': activeIndex === index }"
        @click="select(index)"
      >
        <img :src="item" width="44" height="44" class="rounded-lg" loading="lazy">
      </div>
    </div>
  </div>
</template>
```
