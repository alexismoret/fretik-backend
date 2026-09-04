# ULink

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Link component
 */
interface LinkProps {
  /**
   * The element or component this component should render as when not a link.
   * @default 'button'
   */
  as?: any;
  /**
   * The type of the button when not a link.
   * @default 'button'
   */
  type?: "reset" | "submit" | "button" | undefined;
  disabled?: boolean | undefined;
  /**
   * Force the link to be active independent of the current route.
   * @default undefined
   */
  active?: boolean | undefined;
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
   * Whether RouterLink should not wrap its content in an `a` tag. Useful when
   * using `v-slot` to create a custom RouterLink
   */
  custom?: boolean | undefined;
  /**
   * When `true`, only styles from `class`, `activeClass`, and `inactiveClass` will be applied.
   */
  raw?: boolean | undefined;
  /**
   * Control i18n auto-localization when `@nuxtjs/i18n` is installed.
   * - `undefined` / `true` (default): auto-localizes to the current locale using `$localePath`.
   *   Paths already carrying a locale prefix (from e.g. `switchLocalePath()`) are detected
   *   and left untouched to prevent double-prefixing.
   * - `false`: explicitly disables auto-localization.
   * - `string`: localizes to a specific locale (e.g. `'fr'`).
   * @default undefined
   */
  locale?: string | false | true | undefined;
  /**
   * Route Location the link should navigate to when clicked on.
   */
  to?: string | it | et | undefined;
  /**
   * An alias for `to`. If used with `to`, `href` will be ignored
   */
  href?: string | it | et | undefined;
  /**
   * Forces the link to be considered as external (true) or internal (false). This is helpful to handle edge-cases
   */
  external?: boolean | undefined;
  /**
   * Where to display the linked URL, as the name for a browsing context.
   */
  target?: null | string & {} | "_blank" | "_parent" | "_self" | "_top" | undefined;
  /**
   * A rel attribute value to apply on the link. Defaults to "noopener noreferrer" for external links.
   */
  rel?: null | "noopener" | "noreferrer" | "nofollow" | "sponsored" | "ugc" | string & {} | undefined;
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
  /**
   * Class to apply when the link is active
   */
  activeClass?: string | undefined;
  /**
   * Class to apply when the link is exact active
   */
  exactActiveClass?: string | undefined;
  /**
   * Value passed to the attribute `aria-current` when the link is exact active.
   * @default 'page'
   */
  ariaCurrentValue?: "step" | "page" | "true" | "false" | "location" | "date" | "time" | undefined;
  /**
   * Pass the returned promise of `router.push()` to `document.startViewTransition()` if supported.
   */
  viewTransition?: boolean | undefined;
  /**
   * Calls `router.replace` instead of `router.push`.
   */
  replace?: boolean | undefined;
  name?: string | undefined;
  autofocus?: false | true | "true" | "false" | undefined;
  form?: string | undefined;
  formaction?: string | undefined;
  formenctype?: string | undefined;
  formmethod?: string | undefined;
  formnovalidate?: false | true | "true" | "false" | undefined;
  formtarget?: string | undefined;
  referrerpolicy?: "" | "no-referrer" | "no-referrer-when-downgrade" | "origin" | "origin-when-cross-origin" | "same-origin" | "strict-origin" | "strict-origin-when-cross-origin" | "unsafe-url" | undefined;
  download?: any;
  hreflang?: string | undefined;
  media?: string | undefined;
  ping?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#attributes
> 
> This component also supports all native `<a>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Link component
 */
interface LinkSlots {
  default(): any;
}
```

## Usage

The Link component is a wrapper around [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link) using the [`custom`](https://router.vuejs.org/api/interfaces/RouterLinkProps.html#Properties-custom) prop. It provides a few extra props:

- `inactive-class` prop to set a class when the link is inactive, `active-class` is used when active.
- `exact` prop to style with `active-class` when the link is active and the route is exactly the same as the current route.
- `exact-query` and `exact-hash` props to style with `active-class` when the link is active and the query or hash is exactly the same as the current query or hash.

  - use `exact-query="partial"` to style with `active-class` when the link is active and the query partially match the current query.

The incentive behind this is to provide the same API as NuxtLink back in Nuxt 2 / Vue 2. You can read more about it in the Vue Router [migration from Vue 2](https://router.vuejs.org/guide/migration/#removal-of-the-exact-prop-in-router-link) guide.

> [!NOTE]
> 
> It is used by the [`Breadcrumb`](https://ui.nuxt.com/docs/components/breadcrumb), [`Button`](https://ui.nuxt.com/docs/components/button), [`ContextMenu`](https://ui.nuxt.com/docs/components/context-menu), [`DropdownMenu`](https://ui.nuxt.com/docs/components/dropdown-menu) and [`NavigationMenu`](https://ui.nuxt.com/docs/components/navigation-menu) components.

### Tag

The `Link` components renders an `<a>` tag when a `to` prop is provided, otherwise it renders a `<button>` tag. You can use the `as` prop to change fallback tag.

```vue
<template>
  <ULink as="button">
    Link
  </ULink>
</template>
```

> [!NOTE]
> 
> You can inspect the rendered HTML by changing the `to` prop.

### Style

By default, the link has default active and inactive styles, check out the [#theme](#theme) section.

```vue
<template>
  <ULink to="/docs/components/link">
    Link
  </ULink>
</template>
```

> [!NOTE]
> 
> Try changing the `to` prop to see the active and inactive states.

You can override this behavior by using the `raw` prop and provide your own styles using `class`, `active-class` and `inactive-class`.

```vue
<template>
  <ULink raw to="/docs/components/link" active-class="font-bold" inactive-class="text-muted">
    Link
  </ULink>
</template>
```

> [!NOTE]
> 
> If you're using the [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) extension for VSCode and wish to get autocompletion for the `active-class` and `inactive-class` props, you can add the following settings to your `.vscode/settings.json`:
> 
> ```json [.vscode/settings.json]
> {
>   "tailwindCSS.classAttributes": [
>     "active-class",
>     "inactive-class"
>   ]
> }
> ```

### Locale `4.7+`

The Link component automatically integrates with [`@nuxtjs/i18n`](https://i18n.nuxtjs.org/) when installed. Internal links are automatically localized using the `$localePath` helper without requiring manual wrapping.

```vue
<template>
  <!-- Automatically becomes /en/about or /fr/about based on current locale -->
  <ULink to="/about">About</ULink>
</template>
```

> [!TIP]
> 
> You can still manually use `localePath()` or `localeRoute()` if needed.

> [!NOTE]
> See: /docs/getting-started/integrations/i18n/nuxt#dynamic-locale
> 
> Learn more about Internationalization in Nuxt UI.
