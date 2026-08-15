# UInputDate

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the InputDate component
 */
interface InputDateProps {
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
   * @default 'solid'
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
   * Whether or not a range of dates can be selected
   */
  range?: R | undefined;
  defaultValue?: CalendarDate | CalendarDateTime | ZonedDateTime | DateRange;
  modelValue?: null | CalendarDate | CalendarDateTime | ZonedDateTime | DateRange;
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
  defaultPlaceholder?: CalendarDate | CalendarDateTime | ZonedDateTime;
  placeholder?: CalendarDate | CalendarDateTime | ZonedDateTime;
  /**
   * The hour cycle used for formatting times. Defaults to the local preference
   */
  hourCycle?: 12 | 24 | undefined;
  /**
   * The stepping interval for the time fields. Defaults to `1`.
   */
  step?: DateStep | undefined;
  /**
   * Whether to enforce snapping the time value to the nearest step increment after input. Defaults to `false`.
   */
  stepSnapping?: boolean | undefined;
  /**
   * The granularity to use for formatting times. Defaults to day if a CalendarDate is provided, otherwise defaults to minute. The field will render segments for each part of the date up to and including the specified granularity
   */
  granularity?: "day" | "hour" | "minute" | "second" | undefined;
  /**
   * Whether or not to hide the time zone segment of the field
   */
  hideTimeZone?: boolean | undefined;
  maxValue?: CalendarDate | CalendarDateTime | ZonedDateTime;
  minValue?: CalendarDate | CalendarDateTime | ZonedDateTime;
  /**
   * The locale to use for formatting dates
   */
  locale?: string | undefined;
  /**
   * Whether or not the date field is disabled
   */
  disabled?: boolean | undefined;
  /**
   * Whether or not the date field is readonly
   */
  readonly?: boolean | undefined;
  /**
   * A function that returns whether or not a date is unavailable
   */
  isDateUnavailable?: (date: DateValue): boolean | undefined;
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
}
```

### Slots

```ts
/**
 * Slots for the InputDate component
 */
interface InputDateSlots {
  leading(): any;
  default(): any;
  trailing(): any;
  separator(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the InputDate component
 */
interface InputDateEmits {
  update:modelValue: (payload: [value: InputDateModelValue<R>]) => void;
  update:placeholder: (payload: [date: DateValue] & [date: DateValue]) => void;
  change: (payload: [event: Event]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  focus: (payload: [event: FocusEvent]) => void;
}
```

## Usage

Use the `v-model` directive to control the selected date.

```vue
<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";

const value = shallowRef(new CalendarDate(2022, 2, 3));
</script>

<template>
  <UInputDate v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";

const defaultValue = shallowRef(new CalendarDate(2022, 2, 6));
</script>

<template>
  <UInputDate :default-value="defaultValue" />
</template>
```

**Nuxt:**

> \[!NOTE]
> See: /docs/getting-started/integrations/i18n/nuxt#locale
>
> This component uses the `@internationalized/date` package for locale-aware formatting. The date format is determined by the `locale` prop of the App component.

**Vue:**

> \[!NOTE]
> See: /docs/getting-started/integrations/i18n/vue#locale
>
> This component uses the `@internationalized/date` package for locale-aware formatting. The date format is determined by the `locale` prop of the App component.

### Range

Use the `range` prop to select a range of dates.

```vue
<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";

const value = shallowRef({
  start: new CalendarDate(2022, 2, 3),
  end: new CalendarDate(2022, 2, 20),
});
</script>

<template>
  <UInputDate range v-model="value" />
</template>
```

### Color

Use the `color` prop to change the color of the InputDate.

```vue
<template>
  <UInputDate color="neutral" highlight />
</template>
```

### Variant

Use the `variant` prop to change the variant of the InputDate.

```vue
<template>
  <UInputDate variant="subtle" />
</template>
```

### Size

Use the `size` prop to change the size of the InputDate.

```vue
<template>
  <UInputDate size="xl" />
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the InputDate.

```vue
<template>
  <UInputDate icon="i-lucide-calendar" />
</template>
```

> \[!NOTE]
>
> Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

### Separator Icon

Use the `separator-icon` prop to change the [Icon](https://ui.nuxt.com/docs/components/icon) of the range separator. Defaults to `i-lucide-minus`.

```vue
<template>
  <UInputDate range separator-icon="i-lucide-arrow-right" />
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

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the InputDate.

```vue
<template>
  <UInputDate
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

Use the `disabled` prop to disable the InputDate.

```vue
<template>
  <UInputDate disabled />
</template>
```

## Examples

### With unavailable dates

Use the `is-date-unavailable` prop with a function to mark specific dates as unavailable.

```vue [InputDateUnavailableDatesExample.vue]
<script setup lang="ts">
import type { DateValue } from "@internationalized/date";
import { CalendarDate } from "@internationalized/date";

const modelValue = shallowRef({
  start: new CalendarDate(2022, 1, 1),
  end: new CalendarDate(2022, 1, 9),
});

const isDateUnavailable = (date: DateValue) => {
  return date.day >= 10 && date.day <= 16;
};
</script>

<template>
  <UInputDate
    v-model="modelValue"
    :is-date-unavailable="isDateUnavailable"
    range
  />
</template>
```

### With min/max dates

Use the `min-value` and `max-value` props to limit the dates.

```vue [InputDateMinMaxDatesExample.vue]
<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";

const modelValue = shallowRef(new CalendarDate(2023, 9, 10));
const minDate = new CalendarDate(2023, 9, 1);
const maxDate = new CalendarDate(2023, 9, 30);
</script>

<template>
  <UInputDate v-model="modelValue" :min-value="minDate" :max-value="maxDate" />
</template>
```

### As a date picker

Use a [Calendar](https://ui.nuxt.com/docs/components/calendar) and a [Popover](https://ui.nuxt.com/docs/components/popover) component to create a date picker.

```vue [InputDateDatePickerExample.vue]
<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";

const inputDate = useTemplateRef("inputDate");

const modelValue = shallowRef(new CalendarDate(2022, 1, 10));
</script>

<template>
  <UInputDate ref="inputDate" v-model="modelValue">
    <template #trailing>
      <UPopover :reference="inputDate?.inputsRef[3]?.$el">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          icon="i-lucide-calendar"
          aria-label="Select a date"
          class="px-0"
        />

        <template #content>
          <UCalendar v-model="modelValue" class="p-2" />
        </template>
      </UPopover>
    </template>
  </UInputDate>
</template>
```

### As a date range picker

Use a [Calendar](https://ui.nuxt.com/docs/components/calendar) and a [Popover](https://ui.nuxt.com/docs/components/popover) component to create a date range picker.

```vue [InputDateDateRangePickerExample.vue]
<script setup lang="ts">
import { CalendarDate } from "@internationalized/date";

const inputDate = useTemplateRef("inputDate");

const modelValue = shallowRef({
  start: new CalendarDate(2022, 1, 10),
  end: new CalendarDate(2022, 1, 20),
});
</script>

<template>
  <UInputDate ref="inputDate" v-model="modelValue" range>
    <template #trailing>
      <UPopover :reference="inputDate?.inputsRef[0]?.$el">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          icon="i-lucide-calendar"
          aria-label="Select a date range"
          class="px-0"
        />

        <template #content>
          <UCalendar
            v-model="modelValue"
            class="p-2"
            :number-of-months="2"
            range
          />
        </template>
      </UPopover>
    </template>
  </UInputDate>
</template>
```
