# UChangelogVersion

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the ChangelogVersion component
 */
interface ChangelogVersionProps {
  /**
   * The element or component this component should render as.
   * @default 'article'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The date of the changelog version. Can be a string or a Date object.
   */
  date?: string | Date | undefined;
  /**
   * Display a badge on the changelog version.
   * Can be a string or an object.
   * `{ color: 'neutral', variant: 'solid' }`{lang="ts-type"}
   */
  badge?: string | BadgeProps | undefined;
  /**
   * The authors of the changelog version.
   */
  authors?: UserProps[] | undefined;
  /**
   * The image of the changelog version. Can be a string or an object.
   */
  image?: string | Partial<ImgHTMLAttributes> & { [key: string]: any; } | undefined;
  /**
   * Display an indicator dot on the left.
   * @default true
   */
  indicator?: boolean | undefined;
  to?: string | it | et | undefined;
  target?: null | "_blank" | "_parent" | "_self" | "_top" | string & {} | undefined;
  onClick?: (event: MouseEvent): void | undefined;
  ui?: { root?: SlotClass; container?: SlotClass; header?: SlotClass; meta?: SlotClass; date?: SlotClass; badge?: SlotClass; title?: SlotClass; description?: SlotClass; imageWrapper?: SlotClass; image?: SlotClass; authors?: SlotClass; footer?: SlotClass; indicator?: SlotClass; dot?: SlotClass; dotInner?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the ChangelogVersion component
 */
interface ChangelogVersionSlots {
  header(): any;
  badge(): any;
  date(): any;
  title(): any;
  description(): any;
  image(): any;
  body(): any;
  footer(): any;
  authors(): any;
  actions(): any;
  indicator(): any;
}
```

## Usage

The ChangelogVersion component provides a flexible way to display an `<article>` element with customizable content including title, description, image, etc.

```vue
<template>
  <u-changelog-version :authors=[{"name":"Benjamin Canac","description":"@benjamincanac","avatar":{"src":"https://github.com/benjamincanac.png","loading":"lazy"},"to":"https://x.com/benjamincanac","target":"_blank"},{"name":"Sebastien Chopin","description":"@atinux","avatar":{"src":"https://github.com/atinux.png","loading":"lazy"},"to":"https://x.com/atinux","target":"_blank"},{"name":"Hugo Richard","description":"@hugorcd__","avatar":{"src":"https://github.com/hugorcd.png","loading":"lazy"},"to":"https://x.com/hugorcd__","target":"_blank"}] :ui={"container":"max-w-lg"} date=2025-03-12 description=Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility. image=https://nuxt.com/assets/blog/nuxt-ui-v3.png target=_blank title=Introducing Nuxt UI v3 to=https://nuxt.com/blog/nuxt-ui-v3 />
</template>
```

> \[!TIP]
> See: /docs/components/changelog-versions
>
> Use the `ChangelogVersions` component to display multiple changelog versions in a timeline with an indicator bar on the left.

### Title

Use the `title` prop to display the title of the ChangelogVersion.

```vue
<template>
  <UChangelogVersion title="Introducing Nuxt UI v3" />
</template>
```

### Description

Use the `description` prop to display the description of the ChangelogVersion.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
  />
</template>
```

### Date

Use the `date` prop to display the date of the ChangelogVersion.

> \[!TIP]
>
> The date is automatically formatted to the [current locale](https://ui.nuxt.com/docs/getting-started/integrations/i18n/nuxt#locale). You can either pass a `Date` object or a string.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
  />
</template>
```

### Badge

Use the `badge` prop to display a [Badge](https://ui.nuxt.com/docs/components/badge) on the ChangelogVersion.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
    badge="Release"
  />
</template>
```

You can pass any property from the [Badge](https://ui.nuxt.com/docs/components/badge#props) component to customize it.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
    :badge="{
      label: 'Release',
      color: 'primary',
      variant: 'outline',
    }"
  />
</template>
```

### Image

Use the `image` prop to display an image in the BlogPost.

> \[!NOTE]
>
> If [`@nuxt/image`](https://image.nuxt.com/get-started/installation){rel="&#x22;nofollow&#x22;"} is installed, the `<NuxtImg>` component will be used instead of the native `img` tag.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
    image="https://nuxt.com/assets/blog/nuxt-ui-v3.png"
  />
</template>
```

### Authors

Use the `authors` prop to display a list of [User](https://ui.nuxt.com/docs/components/user) in the ChangelogVersion as an array of objects with the following properties:

- `name?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `description?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `avatar?: Omit<AvatarProps, 'size'>`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `chip?: boolean | Omit<ChipProps, 'size' | 'inset'>`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `size?: UserProps['size']`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `orientation?: UserProps['orientation']`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { UserProps } from "@nuxt/ui";

const authors = ref<UserProps[]>([
  {
    name: "Benjamin Canac",
    description: "@benjamincanac",
    avatar: {
      src: "https://github.com/benjamincanac.png",
      loading: "lazy",
    },
    to: "https://x.com/benjamincanac",
    target: "_blank",
  },
  {
    name: "Sebastien Chopin",
    description: "@atinux",
    avatar: {
      src: "https://github.com/atinux.png",
      loading: "lazy",
    },
    to: "https://x.com/atinux",
    target: "_blank",
  },
  {
    name: "Hugo Richard",
    description: "@hugorcd__",
    avatar: {
      src: "https://github.com/hugorcd.png",
      loading: "lazy",
    },
    to: "https://x.com/hugorcd__",
    target: "_blank",
  },
]);
</script>

<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
    image="https://nuxt.com/assets/blog/nuxt-ui-v3.png"
    :authors="authors"
  />
</template>
```

### Link

You can pass any property from the [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link){rel="&#x22;nofollow&#x22;"} component such as `to`, `target`, `rel`, etc.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
    image="https://nuxt.com/assets/blog/nuxt-ui-v3.png"
    to="https://nuxt.com/blog/nuxt-ui-v3"
    target="_blank"
  />
</template>
```

### Indicator

Use the `indicator` prop to hide the indicator dot on the left. Defaults to `true`.

```vue
<template>
  <UChangelogVersion
    title="Introducing Nuxt UI v3"
    description="Nuxt UI v3 is out! After 1500+ commits, this major redesign brings improved accessibility, Tailwind CSS support, and full Vue compatibility."
    date="2025-03-12"
    image="https://nuxt.com/assets/blog/nuxt-ui-v3.png"
    :indicator="false"
  />
</template>
```

> \[!NOTE]
>
> When the `indicator` prop is `false`, the date will be displayed over the title.

## Examples

### With body slot

You can use the `body` slot to display custom content between the image and the authors with:

- the [MDC](https://github.com/nuxt-content/mdc?tab=readme-ov-file#mdc){rel="&#x22;nofollow&#x22;"} component from `@nuxtjs/mdc` to display some markdown.
- the [ContentRenderer](https://content.nuxt.com/docs/components/content-renderer){rel="&#x22;nofollow&#x22;"} component from `@nuxt/content` to render the content of the page or list.
- or use the `:u-changelog-version` component directly in your content with markdown inside the `body` slot as Nuxt UI provides pre-styled prose components.

```vue [ChangelogVersionMarkdownExample.vue]
<script setup lang="ts">
const content = `
![Nuxt UI v3](https://nuxt.com/assets/blog/nuxt-ui-v3.png)

We are thrilled to introduce Nuxt UI v3, a comprehensive redesign of our UI library that delivers significant improvements in accessibility, performance, and developer experience. This major update represents over 1,500 commits of dedicated work, collaboration, and innovation from our team and the community.

Read the blog post announcement: https://nuxt.com/blog/nuxt-ui-v3

**[Get started with Nuxt UI v3 →](https://ui3.nuxt.com/getting-started/installation/nuxt)**

### 🧩 Reka UI: A New Foundation

We've transitioned from [Headless UI](https://headlessui.com/) to [Reka UI](https://reka-ui.com/) as our core component foundation, bringing:

- **Expanded Component Library**: Access to 55+ primitives, significantly expanding our component offerings
- **Future-Proof Development**: Benefit from Reka UI's growing popularity and continuous improvements
- **First-Class Accessibility**: Built-in accessibility features aligned with our commitment to inclusive design

### 🚀 Tailwind CSS Integration

Nuxt UI now leverages the latest [Tailwind CSS](https://tailwindcss.com), delivering:

- **Exceptional Performance**: Full builds up to 5× faster, with incremental builds over 100× faster
- **Streamlined Toolchain**: Built-in import handling, vendor prefixing, and syntax transforms with zero additional tooling
- **CSS-First Configuration**: Customize and extend the framework directly in CSS instead of JavaScript configuration

### 🎨 Tailwind Variants

We've adopted [Tailwind Variants](https://www.tailwind-variants.org/) to power our design system, offering:

- **Dynamic Styling**: Create flexible component variants with a powerful, intuitive API
- **Type Safety**: Full TypeScript support with intelligent auto-completion
- **Smart Conflict Resolution**: Efficiently merge conflicting styles with predictable results
```
