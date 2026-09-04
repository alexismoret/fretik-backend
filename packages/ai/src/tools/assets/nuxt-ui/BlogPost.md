# UBlogPost

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the BlogPost component
 */
interface BlogPostProps {
  /**
   * The element or component this component should render as.
   * @default 'article'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * The date of the blog post. Can be a string or a Date object.
   */
  date?: string | Date | undefined;
  /**
   * Display a badge on the blog post.
   * Can be a string or an object.
   * `{ color: 'neutral', variant: 'subtle' }`{lang="ts-type"}
   */
  badge?: string | BadgeProps | undefined;
  /**
   * The authors of the blog post.
   */
  authors?: UserProps[] | undefined;
  /**
   * The image of the blog post. Can be a string or an object.
   */
  image?: string | Partial<ImgHTMLAttributes> & { [key: string]: any; } | undefined;
  /**
   * The orientation of the blog post.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "outline" | "soft" | "subtle" | "ghost" | "naked" | undefined;
  to?: string | it | et | undefined;
  target?: null | "_blank" | "_parent" | "_self" | "_top" | string & {} | undefined;
  onClick?: (event: MouseEvent): void | undefined;
  ui?: { root?: SlotClass; header?: SlotClass; body?: SlotClass; footer?: SlotClass; image?: SlotClass; title?: SlotClass; description?: SlotClass; authors?: SlotClass; avatar?: SlotClass; meta?: SlotClass; date?: SlotClass; badge?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the BlogPost component
 */
interface BlogPostSlots {
  date(): any;
  badge(): any;
  title(): any;
  description(): any;
  authors(): any;
  header(): any;
  body(): any;
  footer(): any;
}
```

## Composition

Parts placed by name: `#date`, `#badge`, `#authors`, `#body`.

## Usage

The BlogPost component provides a flexible way to display an `<article>` element with customizable content including title, description, image, etc.

```vue
<template>
  <u-blog-post :authors="[
    {
      name: 'Anthony Fu',
      description: 'antfu7',
      avatar: {
        src: 'https://github.com/antfu.png',
        loading: 'lazy'
      },
      to: 'https://github.com/antfu',
      target: '_blank'
    }
  ]" class="w-96" date="2024-11-25" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" target="_blank" title="Introducing Nuxt Icon v1" to="https://nuxt.com/blog/nuxt-icon-v1-0" />
</template>
```

> [!TIP]
> See: /docs/components/blog-posts
> 
> Use the `BlogPosts` component to display multiple blog posts in a responsive grid layout.

### Title

Use the `title` prop to display the title of the BlogPost.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" />
</template>
```

### Description

Use the `description` prop to display the description of the BlogPost.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." />
</template>
```

### Date

Use the `date` prop to display the date of the BlogPost.

> [!TIP]
> 
> The date is automatically formatted to the [current locale](https://ui.nuxt.com/docs/getting-started/integrations/i18n/nuxt#locale). You can either pass a `Date` object or a string.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." date="2024-11-25" />
</template>
```

### Badge

Use the `badge` prop to display a [Badge](https://ui.nuxt.com/docs/components/badge) in the BlogPost.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." badge="Release" />
</template>
```

You can pass any property from the [Badge](https://ui.nuxt.com/docs/components/badge#props) component to customize it.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." :badge="{
  label: 'Release',
  color: 'primary',
  variant: 'solid'
}" />
</template>
```

### Image

Use the `image` prop to display an image in the BlogPost.

> [!NOTE]
> 
> If [`@nuxt/image`](https://image.nuxt.com/get-started/installation) is installed, the `<NuxtImg>` component will be used instead of the native `img` tag.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" date="2024-11-25" />
</template>
```

### Authors

Use the `authors` prop to display a list of [User](https://ui.nuxt.com/docs/components/user) in the BlogPost as an array of objects with the following properties:

- `name?: string`
- `description?: string`
- `avatar?: Omit<AvatarProps, 'size'>`
- `chip?: boolean | Omit<ChipProps, 'size' | 'inset'>`
- `size?: UserProps['size']`
- `orientation?: UserProps['orientation']`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue
<script setup lang="ts">
import type { UserProps } from '@nuxt/ui'

const authors = ref<UserProps[]>([
  {
    name: "Anthony Fu",
    description: "antfu7",
    avatar: {
      src: "https://github.com/antfu.png",
      loading: "lazy"
    },
    to: "https://github.com/antfu",
    target: "_blank"
  }
])
</script>

<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" date="2024-11-25" :authors="authors" />
</template>
```

When the `authors` prop has more than one item, the [AvatarGroup](https://ui.nuxt.com/docs/components/avatar-group) component is used.

```vue
<script setup lang="ts">
import type { UserProps } from '@nuxt/ui'

const authors = ref<UserProps[]>([
  {
    name: "Anthony Fu",
    description: "antfu7",
    avatar: {
      src: "https://github.com/antfu.png",
      loading: "lazy"
    },
    to: "https://github.com/antfu",
    target: "_blank"
  },
  {
    name: "Benjamin Canac",
    description: "benjamincanac",
    avatar: {
      src: "https://github.com/benjamincanac.png",
      loading: "lazy"
    },
    to: "https://github.com/benjamincanac",
    target: "_blank"
  }
])
</script>

<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" date="2024-11-25" :authors="authors" />
</template>
```

### Link

You can pass any property from the [`<NuxtLink>`](https://nuxt.com/docs/api/components/nuxt-link) component such as `to`, `target`, `rel`, etc.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" date="2024-11-25" to="https://nuxt.com/blog/nuxt-icon-v1-0" target="_blank" />
</template>
```

### Variant

Use the `variant` prop to change the style of the BlogPost.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" date="2024-11-25" to="https://nuxt.com/blog/nuxt-icon-v1-0" target="_blank" variant="naked" />
</template>
```

> [!NOTE]
> 
> The styling will be different wether you provide a `to` prop or an `image`.

### Orientation

Use the `orientation` prop to change the BlogPost orientation. Defaults to `vertical`.

```vue
<template>
  <UBlogPost title="Introducing Nuxt Icon v1" description="Discover Nuxt Icon v1 - a modern, versatile, and customizable icon solution for your Nuxt projects." image="https://nuxt.com/assets/blog/nuxt-icon/cover.png" date="2024-11-25" to="https://nuxt.com/blog/nuxt-icon-v1-0" target="_blank" orientation="horizontal" variant="outline" />
</template>
```
