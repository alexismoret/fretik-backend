# UApp

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the App component
 */
interface AppProps {
  tooltip?: TooltipProviderProps | undefined;
  toaster?: null | ToasterProps | undefined;
  locale?: Locale<T> | undefined;
  /**
   * @default 'body'
   */
  portal?: string | false | true | HTMLElement | undefined;
  /**
   * The global reading direction of your application. This will be inherited by all primitives.
   * @default 'ltr'
   */
  dir?: "ltr" | "rtl" | undefined;
  /**
   * The global scroll body behavior of your application. This will be inherited by the related primitives.
   */
  scrollBody?: boolean | ScrollBodyOption | undefined;
  /**
   * The global `nonce` value of your application. This will be inherited by the related primitives.
   */
  nonce?: string | undefined;
}
```

### Slots

```ts
/**
 * Slots for the App component
 */
interface AppSlots {
  default(): any;
}
```

## Usage

This component implements Reka UI [ConfigProvider](https://reka-ui.com/docs/utilities/config-provider) to provide global configuration to all components:

- Enables all primitives to inherit global reading direction.
- Enables changing the behavior of scroll body when setting body lock.
- Much more controls to prevent layout shifts.

It's also using [ToastProvider](https://reka-ui.com/docs/components/toast#provider) and [TooltipProvider](https://reka-ui.com/docs/components/tooltip#provider) to provide global toasts and tooltips, as well as programmatic modals and slideovers.

Wrap your entire application with the App component in your `app.vue` file:

```vue [app.vue]
<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/i18n/nuxt#locale
> 
> Learn how to use the `locale` prop to change the locale of your app. This also controls the date/time format in components like Calendar, InputDate, and InputTime.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/i18n/vue#locale
> 
> Learn how to use the `locale` prop to change the locale of your app. This also controls the date/time format in components like Calendar, InputDate, and InputTime.
