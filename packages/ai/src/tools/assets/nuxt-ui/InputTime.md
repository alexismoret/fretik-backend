# UInputTime

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the InputTime component
 */
interface InputTimeProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "ghost" | "none" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  /**
   * The icon to use as a range separator.
   * @default appConfig.ui.icons.minus
   */
  separatorIcon?: any;
  /**
   * Enable time range selection.
   * @default false
   */
  range?: R | undefined;
  defaultValue?: Time | CalendarDateTime | ZonedDateTime;
  modelValue?: null | Time | CalendarDateTime | ZonedDateTime;
  ui?: { base?: SlotClass; leading?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailing?: SlotClass; trailingIcon?: SlotClass; segment?: SlotClass; separatorIcon?: SlotClass; } | undefined;
  /**
   * Display an icon based on the `leading` and `trailing` props.
   */
  icon?: any;
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
  defaultPlaceholder?: Time | CalendarDateTime | ZonedDateTime;
  placeholder?: Time | CalendarDateTime | ZonedDateTime;
  /**
   * The hour cycle used for formatting times. Defaults to the local preference
   */
  hourCycle?: 12 | 24 | undefined;
  /**
   * The stepping interval for the time fields. Defaults to `1`.
   */
  step?: DateStep | undefined;
  /**
   * Whether to enforce snapping the value to the nearest step increment after input. Defaults to `false`.
   */
  stepSnapping?: boolean | undefined;
  /**
   * The granularity to use for formatting times. Defaults to minute if a Time is provided, otherwise defaults to minute. The field will render segments for each part of the date up to and including the specified granularity
   */
  granularity?: "hour" | "minute" | "second" | undefined;
  /**
   * Whether or not to hide the time zone segment of the field
   */
  hideTimeZone?: boolean | undefined;
  maxValue?: Time | CalendarDateTime | ZonedDateTime;
  minValue?: Time | CalendarDateTime | ZonedDateTime;
  /**
   * The locale to use for formatting dates
   */
  locale?: string | undefined;
  /**
   * Whether or not the time field is disabled
   */
  disabled?: boolean | undefined;
  /**
   * Whether or not the time field is readonly
   */
  readonly?: boolean | undefined;
  /**
   * Id of the element
   */
  id?: string | undefined;
  /**
   * The name of the field. Submitted with its owning form as part of a name/value pair.
   */
  name?: string | undefined;
  /**
   * When `true`, indicates that the user must set the value before the owning form can be submitted.
   */
  required?: boolean | undefined;
  /**
   * A function that returns whether or not a time is unavailable
   */
  isTimeUnavailable?: (date: DateValue): boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the InputTime component
 */
interface InputTimeSlots {
  leading(): any;
  default(): any;
  trailing(): any;
  separator(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the InputTime component
 */
interface InputTimeEmits {
  update:modelValue: (payload: [value: InputTimeModelValue<R>]) => void;
  update:placeholder: (payload: [date: TimeValue] & [date: TimeValue]) => void;
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  focus: (payload: [event: FocusEvent]) => void;
}
```

## Usage

Use the `v-model` directive to control the selected time.

```vue
<script setup lang="ts">
import { Time } from "@internationalized/date";

const value = shallowRef(new Time(12, 30, 0));
</script>

<template>
  <UInputTime v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
import { Time } from "@internationalized/date";

const defaultValue = shallowRef(new Time(9, 45, 0));
</script>

<template>
  <UInputTime :default-value="defaultValue" />
</template>
```

**Nuxt:**

> \[!NOTE]
> See: /docs/getting-started/integrations/i18n/nuxt#locale
>
> This component uses the `@internationalized/date` package for locale-aware formatting. The time format is determined by the `locale` prop of the App component.

**Vue:**

> \[!NOTE]
> See: /docs/getting-started/integrations/i18n/vue#locale
>
> This component uses the `@internationalized/date` package for locale-aware formatting. The time format is determined by the `locale` prop of the App component.

### Range

Use the `range` prop to enable time range selection with start and end times.

```vue
<script setup lang="ts">
import { Time } from "@internationalized/date";

const value = shallowRef({
  start: new Time(9, 0, 0),
  end: new Time(17, 30, 0),
});
</script>

<template>
  <UInputTime range v-model="value" />
</template>
```

### Hour Cycle

Use the `hour-cycle` prop to change the hour cycle of the InputTime. Defaults to `12`.

```vue
<script setup lang="ts">
import { Time } from "@internationalized/date";

const defaultValue = shallowRef(new Time(16, 30, 0));
</script>

<template>
  <UInputTime :hour-cycle="24" :default-value="defaultValue" />
</template>
```

### Color

Use the `color` prop to change the color of the InputTime.

```vue
<template>
  <UInputTime color="neutral" highlight />
</template>
```

> \[!NOTE]
>
> The `highlight` prop is used here to show the focus state. It's used internally when a validation error occurs.

### Variant

Use the `variant` prop to change the variant of the InputTime.

```vue
<template>
  <UInputTime variant="subtle" />
</template>
```

### Size

Use the `size` prop to change the size of the InputTime.

```vue
<template>
  <UInputTime size="xl" />
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the InputTime.

```vue
<template>
  <UInputTime icon="i-lucide-clock" />
</template>
```

> \[!NOTE]
>
> Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

### Separator Icon

Use the `separator-icon` prop to change the [Icon](https://ui.nuxt.com/docs/components/icon) of the range separator. Defaults to `i-lucide-minus`.

```vue
<template>
  <UInputTime range separator-icon="i-lucide-arrow-right" />
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize this icon globally in your `app.config.ts` under `ui.icons.minus` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.minus` key.

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the InputTime.

```vue
<template>
  <UInputTime
    :avatar="{
      src: 'https://github.com/vuejs.png',
      loading: 'lazy',
    }"
    size="md"
    variant="outline"
  />
</template>
```

### Disabled

Use the `disabled` prop to disable the InputTime.

```vue
<template>
  <UInputTime disabled />
</template>
```

## Examples

### Within a FormField

You can use the InputTime within a [FormField](https://ui.nuxt.com/docs/components/form-field) component to display a label, help text, required indicator, etc.

```vue [InputTimeFormFieldExample.vue]
<script setup lang="ts">
import { Time } from "@internationalized/date";

const time = shallowRef(new Time(12, 30, 0));
</script>

<template>
  <UFormField label="Time" help="Specify the time" required>
    <UInputTime v-model="time" />
  </UFormField>
</template>
```
