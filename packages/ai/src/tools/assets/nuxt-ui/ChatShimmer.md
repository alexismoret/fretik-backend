# UChatShimmer

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChatShimmer component
 */
interface ChatShimmerProps {
  /**
   * The text to display with the shimmer effect.
   */
  text: string;
  /**
   * The element or component this component should render as.
   * @default 'span'
   */
  as?: any;
  /**
   * The duration of the shimmer animation in seconds.
   * @default 2
   */
  duration?: number | undefined;
  /**
   * The spread multiplier for the shimmer highlight. The actual spread is computed as `text.length * spread` in pixels.
   * @default 2
   */
  spread?: number | undefined;
  ui?: {} | undefined;
}
```

## Usage

The ChatShimmer component renders an element with an animated shimmer gradient over text, commonly used to indicate streaming or loading states in chat interfaces.

> \[!NOTE]
>
> This component is automatically used by the [`ChatTool`](https://ui.nuxt.com/docs/components/chat-tool) and [`ChatReasoning`](https://ui.nuxt.com/docs/components/chat-reasoning) components when streaming.

> \[!TIP]
>
> The animation is automatically disabled when the user prefers reduced motion, the text is displayed as static muted text instead.

### Text

Use the `text` prop to set the shimmer text.

```vue
<template>
  <UChatShimmer text="Thinking..." />
</template>
```

### Duration

Use the `duration` prop to control the animation speed in seconds.

```vue
<template>
  <UChatShimmer text="Thinking..." :duration="4" />
</template>
```

### Spread

Use the `spread` prop to control the width of the shimmer highlight. The actual spread is computed as `text.length * spread` in pixels.

```vue
<template>
  <UChatShimmer text="Thinking..." :spread="5" />
</template>
```

## Examples

> \[!TIP]
> See: /docs/components/chat
>
> Check the **Chat** overview page for installation instructions, server setup and usage examples.
