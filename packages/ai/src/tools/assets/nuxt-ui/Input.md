# UInput

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Input component
 */
interface InputProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  id?: string | undefined;
  name?: string | undefined;
  /**
   * @default 'text'
   */
  type?:
    | "number"
    | "image"
    | "text"
    | "button"
    | "search"
    | "time"
    | "color"
    | "checkbox"
    | "date"
    | "datetime-local"
    | "email"
    | "file"
    | "hidden"
    | "month"
    | "password"
    | "radio"
    | "range"
    | "reset"
    | "submit"
    | "tel"
    | "url"
    | "week"
    | (string & {})
    | undefined;
  /**
   * The placeholder text when the input is empty.
   */
  placeholder?: string | undefined;
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
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "ghost" | "none" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  required?: boolean | undefined;
  /**
   * @default 'off'
   */
  autocomplete?: (string & {}) | "on" | "off" | undefined;
  autofocus?: boolean | undefined;
  /**
   * @default 0
   */
  autofocusDelay?: number | undefined;
  disabled?: boolean | undefined;
  /**
   * Highlight the ring color like a focus state.
   */
  highlight?: boolean | undefined;
  /**
   * Keep the mobile text size on all breakpoints.
   */
  fixed?: boolean | undefined;
  modelValue?: _Number<_Optional<_Nullable<T, Mod>, Mod>, Mod> | undefined;
  defaultValue?: _Number<_Optional<_Nullable<T, Mod>, Mod>, Mod> | undefined;
  modelModifiers?: Mod | undefined;
  ui?:
    | {
        root?: SlotClass;
        base?: SlotClass;
        leading?: SlotClass;
        leadingIcon?: SlotClass;
        leadingAvatar?: SlotClass;
        leadingAvatarSize?: SlotClass;
        trailing?: SlotClass;
        trailingIcon?: SlotClass;
      }
    | undefined;
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
  enterKeyHint?:
    | "search"
    | "enter"
    | "done"
    | "go"
    | "next"
    | "previous"
    | "send"
    | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  list?: string | undefined;
  max?: string | number | undefined;
  maxlength?: string | number | undefined;
  min?: string | number | undefined;
  minlength?: string | number | undefined;
  pattern?: string | undefined;
  readonly?: false | true | "true" | "false" | undefined;
  step?: string | number | undefined;
}
```

> \[!NOTE]
> See: https\://developer.mozilla.org/en-US/docs/Web/HTML/Element/input#attributes
>
> This component also supports all native `<input>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Input component
 */
interface InputSlots {
  leading(): any;
  default(): any;
  trailing(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Input component
 */
interface InputEmits {
  update:modelValue: (payload: [value: _Number<_Optional<_Nullable<T, Mod>, Mod>, Mod>]) => void;
  blur: (payload: [event: FocusEvent]) => void;
  change: (payload: [event: Event]) => void;
}
```

### Expose

When accessing the component via a template ref, you can use the following:

| Name                                                                                                                           | Type                  |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `inputRef`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} | `Ref<HTMLInputElement | null>`{.language-ts-type.shiki.shiki-themes.material-theme-lighter.material-theme.material-theme-palenight lang="ts-type"} |

## Usage

Use the `v-model` directive to control the value of the Input.

```vue
<script setup lang="ts">
const value = ref("");
</script>

<template>
  <UInput />
</template>
```

### Type

Use the `type` prop to change the input type. Defaults to `text`.

Some types have been implemented in their own components such as [Checkbox](https://ui.nuxt.com/docs/components/checkbox), [Radio](https://ui.nuxt.com/docs/components/radio-group), [InputNumber](https://ui.nuxt.com/docs/components/input-number) etc. and others have been styled like `file` for example.

```vue
<template>
  <UInput type="file" />
</template>
```

> \[!NOTE]
> See: https\://developer.mozilla.org/en-US/docs/Web/HTML/Element/input#input\_types
>
> You can check all the available types on the MDN Web Docs.

### Placeholder

Use the `placeholder` prop to set a placeholder text.

```vue
<template>
  <UInput placeholder="Search..." />
</template>
```

### Color

Use the `color` prop to change the ring color when the Input is focused.

```vue
<template>
  <UInput color="neutral" highlight placeholder="Search..." />
</template>
```

> \[!NOTE]
>
> The `highlight` prop is used here to show the focus state. It's used internally when a validation error occurs.

### Variant

Use the `variant` prop to change the variant of the Input.

```vue
<template>
  <UInput
    color="neutral"
    variant="subtle"
    :highlight="false"
    placeholder="Search..."
  />
</template>
```

### Size

Use the `size` prop to change the size of the Input.

```vue
<template>
  <UInput size="xl" placeholder="Search..." />
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the Input.

```vue
<template>
  <UInput
    icon="i-lucide-search"
    size="md"
    variant="outline"
    placeholder="Search..."
  />
</template>
```

Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

```vue
<template>
  <UInput
    trailing-icon="i-lucide-at-sign"
    placeholder="Enter your email"
    size="md"
  />
</template>
```

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the Input.

```vue
<template>
  <UInput
    :avatar="{
      src: 'https://github.com/nuxt.png',
      loading: 'lazy',
    }"
    size="md"
    variant="outline"
    placeholder="Search..."
  />
</template>
```

### Loading

Use the `loading` prop to show a loading icon on the Input.

```vue
<template>
  <UInput loading :trailing="false" placeholder="Search..." />
</template>
```

### Loading Icon

Use the `loading-icon` prop to customize the loading icon. Defaults to `i-lucide-loader-circle`.

```vue
<template>
  <UInput loading loading-icon="i-lucide-loader" placeholder="Search..." />
</template>
```

**Nuxt:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
>
> You can customize this icon globally in your `app.config.ts` under `ui.icons.loading` key.

**Vue:**

> \[!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
>
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.loading` key.

### Disabled

Use the `disabled` prop to disable the Input.

```vue
<template>
  <UInput disabled placeholder="Search..." />
</template>
```

## Examples

### With clear button

You can put a [Button](https://ui.nuxt.com/docs/components/button) inside the `#trailing` slot to clear the Input.

```vue [InputClearButtonExample.vue]
<script setup lang="ts">
const value = ref("Click to clear");
</script>

<template>
  <UInput
    v-model="value"
    placeholder="Type something..."
    :ui="{ trailing: 'pe-1' }"
  >
    <template v-if="value?.length" #trailing>
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        icon="i-lucide-circle-x"
        aria-label="Clear input"
        @click="value = ''"
      />
    </template>
  </UInput>
</template>
```

### With copy button

You can put a [Button](https://ui.nuxt.com/docs/components/button) inside the `#trailing` slot to copy the value to the clipboard.

```vue [InputCopyButtonExample.vue]
<script setup lang="ts">
import { useClipboard } from "@vueuse/core";

const value = ref("npx nuxt module add ui");

const { copy, copied } = useClipboard();
</script>

<template>
  <UInput v-model="value" :ui="{ trailing: 'pr-0.5' }">
    <template v-if="value?.length" #trailing>
      <UTooltip text="Copy to clipboard" :content="{ side: 'right' }">
        <UButton
          :color="copied ? 'success' : 'neutral'"
          variant="link"
          size="sm"
          :icon="copied ? 'i-lucide-copy-check' : 'i-lucide-copy'"
          aria-label="Copy to clipboard"
          @click="copy(value)"
        />
      </UTooltip>
    </template>
  </UInput>
</template>
```

### With password toggle

You can put a [Button](https://ui.nuxt.com/docs/components/button) inside the `#trailing` slot to toggle the password visibility.

```vue [InputPasswordToggleExample.vue]
<script setup lang="ts">
const show = ref(false);
const password = ref("");
</script>

<template>
  <UInput
    v-model="password"
    placeholder="Password"
    :type="show ? 'text' : 'password'"
    :ui="{ trailing: 'pe-1' }"
  >
    <template #trailing>
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        :icon="show ? 'i-lucide-eye-off' : 'i-lucide-eye'"
        :aria-label="show ? 'Hide password' : 'Show password'"
        :aria-pressed="show"
        aria-controls="password"
        @click="show = !show"
      />
    </template>
  </UInput>
</template>

<style>
/* Hide the password reveal button in Edge */
::-ms-reveal {
  display: none;
}
</style>
```

### With password strength indicator

You can use the [Progress](https://ui.nuxt.com/docs/components/progress) component to display the password strength indicator.

```vue [InputPasswordStrengthIndicatorExample.vue]
<script setup lang="ts">
const show = ref(false);
const password = ref("");

function checkStrength(str: string) {
  const requirements = [
    { regex: /.{8,}/, text: "At least 8 characters" },
    { regex: /\d/, text: "At least 1 number" },
    { regex: /[a-z]/, text: "At least 1 lowercase letter" },
    { regex: /[A-Z]/, text: "At least 1 uppercase letter" },
  ];

  return requirements.map((req) => ({
    met: req.regex.test(str),
    text: req.text,
  }));
}

const strength = computed(() => checkStrength(password.value));
const score = computed(() => strength.value.filter((req) => req.met).length);

const color = computed(() => {
  if (score.value === 0) return "neutral";
  if (score.value <= 1) return "error";
  if (score.value <= 2) return "warning";
  if (score.value === 3) return "warning";
  return "success";
});

const text = computed(() => {
  if (score.value === 0) return "Enter a password";
  if (score.value <= 2) return "Weak password";
  if (score.value === 3) return "Medium password";
  return "Strong password";
});
</script>

<template>
  <div class="space-y-2">
    <UFormField label="Password">
      <UInput
        v-model="password"
        placeholder="Password"
        :color="color"
        :type="show ? 'text' : 'password'"
        :aria-invalid="score < 4"
        aria-describedby="password-strength"
        :ui="{ trailing: 'pe-1' }"
        class="w-full"
      >
        <template #trailing>
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            :icon="show ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            :aria-label="show ? 'Hide password' : 'Show password'"
            :aria-pressed="show"
            aria-controls="password"
            @click="show = !show"
          />
        </template>
      </UInput>
    </UFormField>

    <UProgress
      :color="color"
      :indicator="text"
      :model-value="score"
      :max="4"
      size="sm"
    />

    <p id="password-strength" class="text-sm font-medium">
      {{ text }}. Must contain:
    </p>

    <ul class="space-y-1" aria-label="Password requirements">
      <li
        v-for="(req, index) in strength"
        :key="index"
        class="flex items-center gap-0.5"
        :class="req.met ? 'text-success' : 'text-muted'"
      >
        <UIcon
          :name="req.met ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
          class="size-4 shrink-0"
        />

        <span class="text-xs font-light">
          {{ req.text }}
          <span class="sr-only">
            {{ req.met ? " - Requirement met" : " - Requirement not met" }}
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
