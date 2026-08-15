# UAvatarGroup

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the AvatarGroup component
 */
interface AvatarGroupProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'md'
   */
  size?:
    | "md"
    | "xs"
    | "sm"
    | "lg"
    | "xl"
    | "3xs"
    | "2xs"
    | "2xl"
    | "3xl"
    | undefined;
  /**
   * @default 'neutral'
   */
  color?:
    | "error"
    | "primary"
    | "secondary"
    | "success"
    | "info"
    | "warning"
    | "neutral"
    | undefined;
  /**
   * The maximum number of avatars to display.
   */
  max?: string | number | undefined;
  ui?: { root?: SlotClass; base?: SlotClass } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the AvatarGroup component
 */
interface AvatarGroupSlots {
  default(): any;
}
```

## Usage

Wrap multiple [Avatar](https://ui.nuxt.com/docs/components/avatar) within an AvatarGroup to stack them.

```vue
<template>
  <UAvatarGroup>
    <UAvatar src="https://github.com/benjamincanac.png" alt="Benjamin Canac" />
    <UAvatar src="https://github.com/romhml.png" alt="Romain Hamel" />
    <UAvatar src="https://github.com/noook.png" alt="Neil Richter" />
  </UAvatarGroup>
</template>
```

### Size

Use the `size` prop to change the size of all the avatars.

```vue
<template>
  <UAvatarGroup size="xl">
    <UAvatar
      src="https://github.com/benjamincanac.png"
      alt="Benjamin Canac"
      loading="lazy"
    />
    <UAvatar
      src="https://github.com/romhml.png"
      alt="Romain Hamel"
      loading="lazy"
    />
    <UAvatar
      src="https://github.com/noook.png"
      alt="Neil Richter"
      loading="lazy"
    />
  </UAvatarGroup>
</template>
```

### Max

Use the `max` prop to limit the number of avatars displayed. The rest is displayed as an `+X` avatar.

```vue
<template>
  <UAvatarGroup :max="2">
    <UAvatar
      src="https://github.com/benjamincanac.png"
      alt="Benjamin Canac"
      loading="lazy"
    />
    <UAvatar
      src="https://github.com/romhml.png"
      alt="Romain Hamel"
      loading="lazy"
    />
    <UAvatar
      src="https://github.com/noook.png"
      alt="Neil Richter"
      loading="lazy"
    />
  </UAvatarGroup>
</template>
```

### Color `4.8+`

Use the `color` prop to change the color of all the avatars.

```vue
<template>
  <UAvatarGroup color="primary">
    <UAvatar alt="Benjamin Canac" />
    <UAvatar alt="Romain Hamel" />
    <UAvatar alt="Neil Richter" />
  </UAvatarGroup>
</template>
```

## Examples

### With tooltip

Wrap each avatar with a [Tooltip](https://ui.nuxt.com/docs/components/tooltip) to display a tooltip on hover.

```vue [AvatarGroupTooltipExample.vue]
<template>
  <UAvatarGroup>
    <UTooltip text="benjamincanac">
      <UAvatar
        src="https://github.com/benjamincanac.png"
        alt="Benjamin Canac"
        loading="lazy"
      />
    </UTooltip>

    <UTooltip text="romhml">
      <UAvatar
        src="https://github.com/romhml.png"
        alt="Romain Hamel"
        loading="lazy"
      />
    </UTooltip>

    <UTooltip text="noook">
      <UAvatar
        src="https://github.com/noook.png"
        alt="Neil Richter"
        loading="lazy"
      />
    </UTooltip>
  </UAvatarGroup>
</template>
```

### With chip

Wrap each avatar with a [Chip](https://ui.nuxt.com/docs/components/chip) to display a chip around the avatar.

```vue [AvatarGroupChipExample.vue]
<template>
  <UAvatarGroup>
    <UAvatar
      src="https://github.com/benjamincanac.png"
      alt="Benjamin Canac"
      loading="lazy"
      :chip="{ inset: true, color: 'success' }"
    />

    <UAvatar
      src="https://github.com/romhml.png"
      alt="Romain Hamel"
      loading="lazy"
      :chip="{ inset: true, color: 'warning' }"
    />

    <UAvatar
      src="https://github.com/noook.png"
      alt="Neil Richter"
      loading="lazy"
      :chip="{ inset: true, color: 'error' }"
    />
  </UAvatarGroup>
</template>
```

### With link

Wrap each avatar with a [Link](https://ui.nuxt.com/docs/components/link) to make them clickable.

```vue [AvatarGroupLinkExample.vue]
<template>
  <UAvatarGroup>
    <ULink
      to="https://github.com/benjamincanac"
      target="_blank"
      class="hover:ring-primary transition"
      raw
    >
      <UAvatar
        src="https://github.com/benjamincanac.png"
        alt="Benjamin Canac"
        loading="lazy"
      />
    </ULink>

    <ULink
      to="https://github.com/romhml"
      target="_blank"
      class="hover:ring-primary transition"
      raw
    >
      <UAvatar
        src="https://github.com/romhml.png"
        alt="Romain Hamel"
        loading="lazy"
      />
    </ULink>

    <ULink
      to="https://github.com/noook"
      target="_blank"
      class="hover:ring-primary transition"
      raw
    >
      <UAvatar
        src="https://github.com/noook.png"
        alt="Neil Richter"
        loading="lazy"
      />
    </ULink>
  </UAvatarGroup>
</template>
```

### With mask

Wrap an avatar with a CSS mask to display it with a custom shape.

```vue [AvatarGroupMaskExample.vue]
<template>
  <UAvatarGroup :ui="{ base: 'rounded-none squircle' }">
    <UAvatar
      src="https://github.com/benjamincanac.png"
      alt="Benjamin Canac"
      loading="lazy"
      class="rounded-none squircle"
    />

    <UAvatar
      src="https://github.com/romhml.png"
      alt="Romain Hamel"
      loading="lazy"
      class="rounded-none squircle"
    />

    <UAvatar
      src="https://github.com/noook.png"
      alt="Neil Richter"
      loading="lazy"
      class="rounded-none squircle"
    />
  </UAvatarGroup>
</template>

<style>
.squircle {
  mask-image: url("data:image/svg+xml,%3csvg width='200' height='200' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M100 0C20 0 0 20 0 100s20 100 100 100 100-20 100-100S180 0 100 0Z'/%3e%3c/svg%3e");
  mask-size: contain;
  mask-position: center;
  mask-repeat: no-repeat;
}
</style>
```

> \[!WARNING]
>
> The `chip` prop does not work correctly when using a mask. Chips may be cut depending on the mask shape.
