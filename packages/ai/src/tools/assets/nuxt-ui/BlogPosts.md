# UBlogPosts

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the BlogPosts component
 */
interface BlogPostsProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  posts?: BlogPostProps[] | undefined;
  /**
   * The orientation of the blog posts.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  ui?: { base?: any; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the BlogPosts component
 */
interface BlogPostsSlots {
  date(): any;
  badge(): any;
  title(): any;
  description(): any;
  authors(): any;
  header(): any;
  body(): any;
  footer(): any;
  default(): any;
}
```

## Composition

Parts placed by name: `#date`, `#badge`, `#authors`, `#body`.

## Usage

The BlogPosts component provides a flexible layout to display a list of [BlogPost](https://ui.nuxt.com/docs/components/blog-post) components using either the default slot or the `posts` prop.

```vue
<template>
  <UBlogPosts>
    <UBlogPost
      v-for="(post, index) in posts"
      :key="index"
      v-bind="post"
    />
  </UBlogPosts>
</template>
```

### Posts

Use the `posts` prop as an array of objects with the properties of the [BlogPost](https://ui.nuxt.com/docs/components/blog-post#props) component.

```vue
<script setup lang="ts">
import type { BlogPostProps } from '@nuxt/ui'

const posts = ref<BlogPostProps[]>([
  {
    title: "Nuxt Icon v1",
    description: "Discover Nuxt Icon v1!",
    image: "https://nuxt.com/assets/blog/nuxt-icon/cover.png",
    date: "2024-11-25"
  },
  {
    title: "Nuxt 3.14",
    description: "Nuxt 3.14 is out!",
    image: "https://nuxt.com/assets/blog/v3.14.png",
    date: "2024-11-04"
  },
  {
    title: "Nuxt 3.13",
    description: "Nuxt 3.13 is out!",
    image: "https://nuxt.com/assets/blog/v3.13.png",
    date: "2024-08-22"
  }
])
</script>

<template>
  <UBlogPosts :posts="posts" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the BlogPosts. Defaults to `horizontal`.

```vue
<script setup lang="ts">
import type { BlogPostProps } from '@nuxt/ui'

const posts = ref<BlogPostProps[]>([
  {
    title: "Nuxt Icon v1",
    description: "Discover Nuxt Icon v1!",
    image: "https://nuxt.com/assets/blog/nuxt-icon/cover.png",
    date: "2024-11-25"
  },
  {
    title: "Nuxt 3.14",
    description: "Nuxt 3.14 is out!",
    image: "https://nuxt.com/assets/blog/v3.14.png",
    date: "2024-11-04"
  },
  {
    title: "Nuxt 3.13",
    description: "Nuxt 3.13 is out!",
    image: "https://nuxt.com/assets/blog/v3.13.png",
    date: "2024-08-22"
  }
])
</script>

<template>
  <UBlogPosts orientation="vertical" :posts="posts" />
</template>
```

> [!TIP]
> 
> When using the `posts` prop instead of the default slot, the `orientation` of the posts is automatically reversed, `horizontal` to `vertical` and vice versa.

## Examples

> [!NOTE]
> 
> While these examples use [Nuxt Content](https://content.nuxt.com), the components can be integrated with any content management system.

### Within a page

Use the BlogPosts component in a page to create a blog page:

```vue [pages/blog/index.vue]
<script setup lang="ts">
const { data: posts } = await useAsyncData('posts', () => queryCollection('posts').all())
</script>

<template>
  <UPage>
    <UPageHero title="Blog" />

    <UPageBody>
      <UContainer>
        <UBlogPosts>
          <UBlogPost
            v-for="(post, index) in posts"
            :key="index"
            v-bind="post"
            :to="post.path"
          />
        </UBlogPosts>
      </UContainer>
    </UPageBody>
  </UPage>
</template>
```

> [!NOTE]
> 
> In this example, the `posts` are fetched using `queryCollection` from the `@nuxt/content` module.

> [!TIP]
> 
> The `to` prop is overridden here since `@nuxt/content` uses the `path` property.
