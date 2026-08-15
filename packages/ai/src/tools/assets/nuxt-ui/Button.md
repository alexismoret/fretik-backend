# UButton

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Button component
 */
interface ButtonProps {
  label?: string | undefined;
  /**
   * @default 'primary'
   */
  color?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  activeColor?: "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" | undefined;
  /**
   * @default 'solid'
   */
  variant?: "solid" | "outline" | "soft" | "subtle" | "ghost" | "link" | undefined;
  activeVariant?: "solid" | "outline" | "soft" | "subtle" | "ghost" | "link" | undefined;
  /**
   * @default 'md'
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | undefined;
  /**
   * Render the button with equal padding on all sides.
   */
  square?: boolean | undefined;
  /**
   * Render the button full width.
   */
  block?: boolean | undefined;
  /**
   * Set loading state automatically based on the `@click` promise state
   */
  loadingAuto?: boolean | undefined;
  onClick?: (event: MouseEvent): void | ((event: MouseEvent) => void)[] | undefined;
  ui?: { base?: SlotClass; label?: SlotClass; leadingIcon?: SlotClass; leadingAvatar?: SlotClass; leadingAvatarSize?: SlotClass; trailingIcon?: SlotClass; } | undefined;
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
  /**
   * Class to apply when the link is exact active
   */
  exactActiveClass?: string | undefined;
  /**
   * Pass the returned promise of `router.push()` to `document.startViewTransition()` if supported.
   */
  viewTransition?: boolean | undefined;
  autofocus?: false | true | "true" | "false" | undefined;
  disabled?: boolean | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  name?: string | undefined;
  /**
   * The type of the button when not a link.
   * @default 'button'
   */
  type?: "reset" | "submit" | "button" | undefined;
  /**
   * The element or component this component should render as when not a link.
   * @default 'button'
   */
  as?: any;
  /**
   * Force the link to be active independent of the current route.
   */
  active?: boolean | undefined;

  // Props inherited from the Link component: https://ui.nuxt.com/docs/components/link
  /**
   * Route Location the link should navigate to when clicked on.
   */
  to?: string | it | et | undefined;
  /**
   * Class to apply when the link is active
   */
  activeClass?: string | undefined;
  /**
   * Value passed to the attribute `aria-current` when the link is exact active.
   * @default `'page'`
   */
  ariaCurrentValue?: "page" | "step" | "location" | "date" | "time" | "true" | "false" | undefined;
  /**
   * Calls `router.replace` instead of `router.push`.
   */
  replace?: boolean | undefined;
  download?: any;
  /**
   * An alias for `to`. If used with `to`, `href` will be ignored
   */
  href?: string | it | et | undefined;
  hreflang?: string | undefined;
  media?: string | undefined;
  ping?: string | undefined;
  /**
   * A rel attribute value to apply on the link. Defaults to "noopener noreferrer" for external links.
   */
  rel?: null | "noopener" | "noreferrer" | "nofollow" | "sponsored" | "ugc" | string & {} | undefined;
  /**
   * Where to display the linked URL, as the name for a browsing context.
   */
  target?: null | string & {} | "_blank" | "_parent" | "_self" | "_top" | undefined;
  referrerpolicy?: "" | "no-referrer" | "no-referrer-when-downgrade" | "origin" | "origin-when-cross-origin" | "same-origin" | "strict-origin" | "strict-origin-when-cross-origin" | "unsafe-url" | undefined;
  /**
   * Will only be active if the current route is an exact match.
   */
  exact?: boolean | undefined;
  /**
   * Allows controlling how the current route query sets the link as active.
   */
  exactQuery?: boolean | "partial" | undefined;
  /**
   * Will only be active if the current route hash is an exact match.
   */
  exactHash?: boolean | undefined;
  /**
   * The class to apply when the link is inactive.
   */
  inactiveClass?: string | undefined;
  /**
   * Control i18n auto-localization when `@nuxtjs/i18n` is installed.
   * - `undefined` / `true` (default): auto-localizes to the current locale using `$localePath`.
   *   Paths already carrying a locale prefix (from e.g. `switchLocalePath()`) are detected
   *   and left untouched to prevent double-prefixing.
   * - `false`: explicitly disables auto-localization.
   * - `string`: localizes to a specific locale (e.g. `'fr'`).
   */
  locale?: string | false | true | undefined;
  /**
   * Forces the link to be considered as external (true) or internal (false). This is helpful to handle edge-cases
   */
  external?: boolean | undefined;
  /**
   * If set to true, no rel attribute will be added to the link
   */
  noRel?: boolean | undefined;
  /**
   * A class to apply to links that have been prefetched.
   */
  prefetchedClass?: string | undefined;
  /**
   * When enabled will prefetch middleware, layouts and payloads of links in the viewport.
   */
  prefetch?: boolean | undefined;
  /**
   * Allows controlling when to prefetch links. By default, prefetch is triggered only on visibility.
   */
  prefetchOn?: "visibility" | "interaction" | Partial<{ visibility: boolean; interaction: boolean; }> | undefined;
  /**
   * Escape hatch to disable `prefetch` attribute.
   */
  noPrefetch?: boolean | undefined;
  /**
   * An option to either add or remove trailing slashes in the `href` for this specific link.
   * Overrides the global `trailingSlash` option if provided.
   */
  trailingSlash?: "remove" | "append" | undefined;
}
```

> \[!NOTE]
> See: https\://developer.mozilla.org/en-US/docs/Web/HTML/Element/button#attributes
>
> This component also supports all native `<button>` HTML attributes.

> \[!NOTE]
> See: https\://github.com/nuxt/ui/blob/v4/src/runtime/components/Link.vue#L13
>
> The `Button` component extends the `Link` component. Check out the source code on GitHub.

### Slots

```ts
/**
 * Slots for the Button component
 */
interface ButtonSlots {
  leading(): any;
  default(): any;
  trailing(): any;
}
```

## Usage

Use the default slot to set the label of the Button.

```vue
<template>
  <UButton> Button </UButton>
</template>
```

### Label

Use the `label` prop to set the label of the Button.

```vue
<template>
  <UButton label="Button" />
</template>
```

### Color

Use the `color` prop to change the color of the Button.

```vue
<template>
  <UButton color="neutral"> Button </UButton>
</template>
```

### Variant

Use the `variant` prop to change the variant of the Button.

```vue
<template>
  <UButton color="neutral" variant="outline"> Button </UButton>
</template>
```

### Size

Use the `size` prop to change the size of the Button.

```vue
<template>
  <UButton size="xl"> Button </UButton>
</template>
```

### Icon

Use the `icon` prop to show an [Icon](https://ui.nuxt.com/docs/components/icon) inside the Button.

```vue
<template>
  <UButton icon="i-lucide-rocket" size="md" color="primary" variant="solid">
    Button
  </UButton>
</template>
```

Use the `leading` and `trailing` props to set the icon position or the `leading-icon` and `trailing-icon` props to set a different icon for each position.

```vue
<template>
  <UButton trailing-icon="i-lucide-arrow-right" size="md"> Button </UButton>
</template>
```

The `label` as prop or slot is optional so you can use the Button as an icon-only button.

```vue
<template>
  <UButton icon="i-lucide-search" size="md" color="primary" variant="solid" />
</template>
```

### Avatar

Use the `avatar` prop to show an [Avatar](https://ui.nuxt.com/docs/components/avatar) inside the Button.

```vue
<template>
  <UButton
    :avatar="{
      src: 'https://github.com/nuxt.png',
      loading: 'lazy',
    }"
    size="md"
    color="neutral"
    variant="outline"
  >
    Button
  </UButton>
</template>
```

The `label` as prop or slot is optional so you can use the Button as an avatar-only button.

```vue
<template>
  <UButton
    :avatar="{
      src: 'https://github.com/nuxt.png',
      loading: 'lazy',
    }"
    size="md"
    color="neutral"
    variant="outline"
  />
</template>
```

### Link

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<template>
  <UButton to="https://github.com/nuxt/ui" target="_blank"> Button </UButton>
</template>
```

When the Button is a link or when using the `active` prop, you can use the `active-color` and `active-variant` props to customize the active state.

```vue
<template>
  <UButton
    active
    color="neutral"
    variant="outline"
    active-color="primary"
    active-variant="solid"
  >
    Button
  </UButton>
</template>
```

You can also use the `active-class` and `inactive-class` props to customize the active state.

```vue
<template>
  <UButton active active-class="font-bold" inactive-class="font-light">
    Button
  </UButton>
</template>
```

> \[!TIP]
>
> You can configure these styles globally in your `app.config.ts` file under the `ui.button.variants.active` key.
>
> ```ts
> export default defineAppConfig({
>   ui: {
>     button: {
>       variants: {
>         active: {
>           true: {
>             base: "font-bold",
>           },
>         },
>       },
>     },
>   },
> });
> ```

### Loading

Use the `loading` prop to show a loading icon and disable the Button.

```vue
<template>
  <UButton loading :trailing="false"> Button </UButton>
</template>
```

Use the `loading-auto` prop to show the loading icon automatically while the `@click` promise is pending.

```vue [ButtonLoadingAutoExample.vue]
<script setup lang="ts">
async function onClick() {
  return new Promise<void>((res) => setTimeout(res, 1000));
}
</script>

<template>
  <UButton loading-auto @click="onClick"> Button </UButton>
</template>
```

This also works with the [Form](https://ui.nuxt.com/docs/components/form) component.

```vue [ButtonLoadingAutoFormExample.vue]
<script setup lang="ts">
const state = reactive({ fullName: "" });

async function onSubmit() {
  return new Promise<void>((res) => setTimeout(res, 1000));
}

async function validate(data: Partial<typeof state>) {
  if (!data.fullName?.length)
    return [{ name: "fullName", message: "Required" }];
  return [];
}
</script>

<template>
  <UForm :state="state" :validate="validate" @submit="onSubmit">
    <UFormField name="fullName" label="Full name">
      <UInput v-model="state.fullName" />
    </UFormField>
    <UButton type="submit" class="mt-2" loading-auto> Submit </UButton>
  </UForm>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### `class` prop

Use the `class` prop to override the base styles of the Button.

```vue
<template>
  <UButton class="font-bold rounded-full"> Button </UButton>
</template>
```

### `ui` prop

Use the `ui` prop to override the slots styles of the Button.

```vue
<template>
  <UButton
    icon="i-lucide-rocket"
    color="neutral"
    variant="outline"
    :ui="{
      leadingIcon: 'text-primary',
    }"
  >
    Button
  </UButton>
</template>
```
