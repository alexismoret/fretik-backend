# UCalendar

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Calendar component
 */
interface CalendarProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The type of picker.
   * - `date` renders a day calendar whose heading can switch to a month then year view.
   * - `month` renders a standalone month picker.
   * - `year` renders a standalone year picker.
   * @default 'date'
   */
  type?: "date" | "month" | "year" | undefined;
  /**
   * The icon to use for the next year control.
   * @default appConfig.ui.icons.chevronDoubleRight
   */
  nextYearIcon?: any;
  /**
   * Configure the next year button.
   * `{ color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   */
  nextYear?: Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon to use for the next month control.
   * @default appConfig.ui.icons.chevronRight
   */
  nextMonthIcon?: any;
  /**
   * Configure the next month button.
   * `{ color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   */
  nextMonth?: Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon to use for the previous year control.
   * @default appConfig.ui.icons.chevronDoubleLeft
   */
  prevYearIcon?: any;
  /**
   * Configure the prev year button.
   * `{ color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   */
  prevYear?: Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * The icon to use for the previous month control.
   * @default appConfig.ui.icons.chevronLeft
   */
  prevMonthIcon?: any;
  /**
   * Configure the prev month button.
   * `{ color: 'neutral', variant: 'ghost' }`{lang="ts-type"}
   */
  prevMonth?: Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * Whether to make the heading a button that switches between the day, month and year views.
   * Has no effect when `type` is `year`. Can be an object to override the button props.
   * `{ color: 'neutral', variant: 'ghost', block: true }`{lang="ts-type"}
   * @default true
   */
  viewControl?: boolean | Omit<ButtonProps, LinkPropsKeys> | undefined;
  /**
   * @default 'primary'
   */
  color?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'solid'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * Whether or not a range of dates can be selected
   */
  range?: R | undefined;
  /**
   * Whether or not multiple dates can be selected
   */
  multiple?: M | undefined;
  /**
   * Show month controls
   * @default true
   */
  monthControls?: boolean | undefined;
  /**
   * Show year controls
   * @default true
   */
  yearControls?: boolean | undefined;
  defaultValue?: CalendarDate | CalendarDateTime | ZonedDateTime | DateRange | DateValue[];
  modelValue?: null | CalendarDate | CalendarDateTime | ZonedDateTime | DateRange | DateValue[];
  weekNumbers?: boolean | undefined;
  ui?: { root?: SlotClass; header?: SlotClass; body?: SlotClass; heading?: SlotClass; headingLabel?: SlotClass; grid?: SlotClass; gridRow?: SlotClass; gridWeekDaysRow?: SlotClass; gridBody?: SlotClass; headCell?: SlotClass; headCellWeek?: SlotClass; cell?: SlotClass; cellTrigger?: SlotClass; cellWeek?: SlotClass; } | undefined;
  defaultPlaceholder?: CalendarDate | CalendarDateTime | ZonedDateTime;
  placeholder?: CalendarDate | CalendarDateTime | ZonedDateTime;
  /**
   * When combined with `isDateUnavailable`, determines whether non-contiguous ranges, i.e. ranges containing unavailable dates, may be selected.
   */
  allowNonContiguousRanges?: boolean | undefined;
  /**
   * This property causes the previous and next buttons to navigate by the number of months displayed at once, rather than one month
   */
  pagedNavigation?: boolean | undefined;
  /**
   * Whether or not to prevent the user from deselecting a date without selecting another date first
   */
  preventDeselect?: boolean | undefined;
  /**
   * The maximum number of days that can be selected in a range
   */
  maximumDays?: number | undefined;
  /**
   * The day of the week to start the calendar on
   */
  weekStartsOn?: 0 | 1 | 2 | 4 | 5 | 3 | 6 | undefined;
  /**
   * The format to use for the weekday strings provided via the weekdays slot prop
   */
  weekdayFormat?: "narrow" | "short" | "long" | undefined;
  /**
   * Whether or not to always display 6 weeks in the calendar
   * @default true
   */
  fixedWeeks?: boolean | undefined;
  maxValue?: CalendarDate | CalendarDateTime | ZonedDateTime;
  minValue?: CalendarDate | CalendarDateTime | ZonedDateTime;
  /**
   * The locale to use for formatting dates
   */
  locale?: string | undefined;
  /**
   * The number of months to display at once
   */
  numberOfMonths?: number | undefined;
  /**
   * Whether or not the calendar is disabled
   */
  disabled?: boolean | undefined;
  /**
   * Whether or not the calendar is readonly
   */
  readonly?: boolean | undefined;
  /**
   * If true, the calendar will focus the selected day, today, or the first day of the month depending on what is visible when the calendar is mounted
   */
  initialFocus?: boolean | undefined;
  /**
   * A function that returns whether or not a date is disabled
   */
  isDateDisabled?: (date: DateValue): boolean | undefined;
  /**
   * A function that returns whether or not a date is unavailable
   */
  isDateUnavailable?: (date: DateValue): boolean | undefined;
  /**
   * A function that returns whether or not a date is hightable
   */
  isDateHighlightable?: (date: DateValue): boolean | undefined;
  /**
   * A function that returns the next page of the calendar. It receives the current placeholder as an argument inside the component.
   */
  nextPage?: (placeholder: DateValue): DateValue | undefined;
  /**
   * A function that returns the previous page of the calendar. It receives the current placeholder as an argument inside the component.
   */
  prevPage?: (placeholder: DateValue): DateValue | undefined;
  /**
   * Whether or not to disable days outside the current view.
   */
  disableDaysOutsideCurrentView?: boolean | undefined;
  /**
   * Which part of the range should be fixed
   */
  fixedDate?: "start" | "end" | undefined;
  /**
   * A function that returns whether or not a month is disabled
   */
  isMonthDisabled?: (date: DateValue): boolean | undefined;
  /**
   * A function that returns whether or not a month is unavailable
   */
  isMonthUnavailable?: (date: DateValue): boolean | undefined;
  /**
   * A function that returns whether or not a year is disabled
   */
  isYearDisabled?: (date: DateValue): boolean | undefined;
  /**
   * A function that returns whether or not a year is unavailable
   */
  isYearUnavailable?: (date: DateValue): boolean | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Calendar component
 */
interface CalendarSlots {
  heading(): any;
  day(): any;
  week-day(): any;
  month-cell(): any;
  year-cell(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Calendar component
 */
interface CalendarEmits {
  update:modelValue: (payload: [value: CalendarModelValue<R, M>]) => void;
  update:placeholder: (payload: [date: DateValue]) => void;
  update:validModelValue: (payload: [date: DateRange]) => void;
  update:startValue: (payload: [date: DateValue | undefined]) => void;
}
```

## Composition

Parts placed by name: `#heading`, `#day`, `#week-day`, `#month-cell`, `#year-cell`.

Also written in the docs and absent from the interface above — one per column or item: `#content`.

## Usage

Use the `v-model` directive to control the selected date.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const value = shallowRef(new CalendarDate(2022, 2, 3))
</script>

<template>
  <UCalendar v-model="value" />
</template>
```

Use the `default-value` prop to set the initial value when you do not need to control its state.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const defaultValue = shallowRef(new CalendarDate(2022, 2, 6))
</script>

<template>
  <UCalendar :default-value="defaultValue" />
</template>
```

**Nuxt:**

> [!NOTE]
> See: /docs/getting-started/integrations/i18n/nuxt#locale
> 
> This component uses the `@internationalized/date` package for locale-aware formatting. The date format is determined by the `locale` prop of the App component.

**Vue:**

> [!NOTE]
> See: /docs/getting-started/integrations/i18n/vue#locale
> 
> This component uses the `@internationalized/date` package for locale-aware formatting. The date format is determined by the `locale` prop of the App component.

### Type `4.9+`

Use the `type` prop to change what the calendar selects. Defaults to `date`.

When using `date`, click the heading to switch from the day view to a month then year view for quick navigation, then drill back down to pick a date.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const value = shallowRef(new CalendarDate(2022, 2, 1))
</script>

<template>
  <UCalendar type="month" v-model="value" />
</template>
```

Use `type="year"` to render a standalone year picker.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const value = shallowRef(new CalendarDate(2022, 1, 1))
</script>

<template>
  <UCalendar type="year" v-model="value" />
</template>
```

### Multiple

Use the `multiple` prop to allow multiple selections.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const value = shallowRef([new CalendarDate(2022, 2, 4), new CalendarDate(2022, 2, 6), new CalendarDate(2022, 2, 8)])
</script>

<template>
  <UCalendar multiple v-model="value" />
</template>
```

### Range

Use the `range` prop to select a range of dates.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const value = shallowRef({ start: new CalendarDate(2022, 2, 3), end: new CalendarDate(2022, 2, 20) })
</script>

<template>
  <UCalendar range v-model="value" />
</template>
```

The `range` prop also works with `type="month"` and `type="year"`, letting you select a range of months or years.

```vue
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const value = shallowRef({ start: new CalendarDate(2022, 2, 1), end: new CalendarDate(2022, 6, 1) })
</script>

<template>
  <UCalendar type="month" range v-model="value" />
</template>
```

### Number Of Months

Use the `numberOfMonths` prop to change the number of months in the calendar.

```vue
<template>
  <UCalendar :number-of-months="3" />
</template>
```

### Month Controls

Use the `month-controls` prop to show the month controls. Defaults to `true`.

```vue
<template>
  <UCalendar :month-controls="false" />
</template>
```

Use the `prev-month` and `next-month` props to override the month buttons.

```vue
<template>
  <UCalendar :prev-month="{
  color: 'primary',
  variant: 'soft'
}" :next-month="{
  color: 'primary',
  variant: 'soft'
}" />
</template>
```

### Year Controls

Use the `year-controls` prop to show the year controls. Defaults to `true`.

```vue
<template>
  <UCalendar :year-controls="false" />
</template>
```

Use the `prev-year` and `next-year` props to override the year buttons.

```vue
<template>
  <UCalendar :prev-year="{
  color: 'primary',
  variant: 'soft'
}" :next-year="{
  color: 'primary',
  variant: 'soft'
}" />
</template>
```

### View Control `4.9+`

Use the `view-control` prop to make the heading a button that switches between the day, month and year views. Defaults to `true`.

```vue
<template>
  <UCalendar :view-control="false" />
</template>
```

Set the `view-control` prop to an object to override the heading button.

```vue
<template>
  <UCalendar :view-control="{
  color: 'primary',
  variant: 'soft'
}" />
</template>
```

### Fixed Weeks

Use the `fixed-weeks` prop to display the calendar with fixed weeks.

```vue
<template>
  <UCalendar :fixed-weeks="false" />
</template>
```

### Week Numbers `4.4+`

Use the `week-numbers` prop to display week numbers in the calendar.

```vue
<template>
  <UCalendar week-numbers fixed-weeks />
</template>
```

### Color

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With chip events

Use the [Chip](https://ui.nuxt.com/docs/components/chip) component to add events to specific days.

```vue [CalendarEventsExample.vue]
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const modelValue = shallowRef(new CalendarDate(2022, 1, 10))

function getColorByDate(date: Date) {
  const isWeekend = date.getDay() % 6 == 0
  const isDayMeeting = date.getDay() % 3 == 0

  if (isWeekend) {
    return undefined
  }

  if (isDayMeeting) {
    return 'error'
  }

  return 'success'
}
</script>

<template>
  <UCalendar v-model="modelValue">
    <template #day="{ day }">
      <UChip :show="!!getColorByDate(day.toDate('UTC'))" :color="getColorByDate(day.toDate('UTC'))" size="2xs">
        {{ day.day }}
      </UChip>
    </template>
  </UCalendar>
</template>
```

### With disabled dates

Use the `is-date-disabled` prop with a function to mark specific dates as disabled. When using `type="month"` or `type="year"`, use the `is-month-disabled` or `is-year-disabled` prop instead.

```vue [CalendarDisabledDatesExample.vue]
<script setup lang="ts">
import type { DateValue } from '@internationalized/date'
import { CalendarDate } from '@internationalized/date'

const modelValue = shallowRef({
  start: new CalendarDate(2022, 1, 1),
  end: new CalendarDate(2022, 1, 9)
})

const isDateDisabled = (date: DateValue) => {
  return date.day >= 10 && date.day <= 16
}
</script>

<template>
  <UCalendar v-model="modelValue" :is-date-disabled="isDateDisabled" range />
</template>
```

### With unavailable dates

Use the `is-date-unavailable` prop with a function to mark specific dates as unavailable. When using `type="month"` or `type="year"`, use the `is-month-unavailable` or `is-year-unavailable` prop instead.

```vue [CalendarUnavailableDatesExample.vue]
<script setup lang="ts">
import type { DateValue } from '@internationalized/date'
import { CalendarDate } from '@internationalized/date'

const modelValue = shallowRef({
  start: new CalendarDate(2022, 1, 1),
  end: new CalendarDate(2022, 1, 9)
})

const isDateUnavailable = (date: DateValue) => {
  return date.day >= 10 && date.day <= 16
}
</script>

<template>
  <UCalendar v-model="modelValue" :is-date-unavailable="isDateUnavailable" range />
</template>
```

### With min/max dates

Use the `min-value` and `max-value` props to limit the dates.

```vue [CalendarMinMaxDatesExample.vue]
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const modelValue = shallowRef(new CalendarDate(2023, 9, 10))
const minDate = new CalendarDate(2023, 9, 1)
const maxDate = new CalendarDate(2023, 9, 30)
</script>

<template>
  <UCalendar v-model="modelValue" :min-value="minDate" :max-value="maxDate" />
</template>
```

### With other calendar systems

You can use other calenders from `@internationalized/date` to implement a different calendar system.

```vue [CalendarOtherSystemExample.vue]
<script lang="ts" setup>
import { CalendarDate, HebrewCalendar } from '@internationalized/date'

const hebrewDate = shallowRef(new CalendarDate(new HebrewCalendar(), 5781, 1, 1))
</script>

<template>
  <UCalendar v-model="hebrewDate" />
</template>
```

> [!NOTE]
> See: https://react-spectrum.adobe.com/internationalized/date/Calendar.html#implementations
> 
> You can check all the available calendars on `@internationalized/date` docs.

### With external controls

You can control the calendar with external controls by manipulating the date passed in the `v-model`.

```vue [CalendarExternalControlsExample.vue]
<script setup lang="ts">
import { CalendarDate } from '@internationalized/date'

const date = shallowRef(new CalendarDate(2025, 4, 2))
</script>

<template>
  <div class="flex flex-col gap-4">
    <UCalendar v-model="date" :month-controls="false" :year-controls="false" />

    <div class="flex justify-between gap-4">
      <UButton color="neutral" variant="outline" @click="date = date.subtract({ months: 1 })">
        Prev
      </UButton>

      <UButton color="neutral" variant="outline" @click="date = date.add({ months: 1 })">
        Next
      </UButton>
    </div>
  </div>
</template>
```

### With today's date

Use the `today` function from `@internationalized/date` with `getLocalTimeZone` to set the value to the current date.

```vue [CalendarTodayExample.vue]
<script setup lang="ts">
import { getLocalTimeZone, today } from '@internationalized/date'

const date = shallowRef(today(getLocalTimeZone()))
</script>

<template>
  <div class="flex flex-col gap-4">
    <UCalendar v-model="date" />

    <UButton color="neutral" variant="outline" class="justify-center" @click="date = today(getLocalTimeZone())">
      Today
    </UButton>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
