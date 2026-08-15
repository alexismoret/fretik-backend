# UMarquee

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Marquee component
 */
interface MarqueeProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * Pause the marquee on hover.
   * @default false
   */
  pauseOnHover?: boolean | undefined;
  /**
   * Reverse the direction of the marquee.
   * @default false
   */
  reverse?: boolean | undefined;
  /**
   * The orientation of the marquee.
   * @default 'horizontal'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * The number of times the marquee should repeat.
   * @default 4
   */
  repeat?: number | undefined;
  /**
   * Display an overlay on the marquee.
   * @default true
   */
  overlay?: boolean | undefined;
  ui?: { root?: SlotClass; content?: SlotClass } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Marquee component
 */
interface MarqueeSlots {
  default(): any;
}
```

## Usage

Use the default slot with your content to create an infinite scrolling animation.

```vue
<template>
  <UMarquee>
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UMarquee>
</template>
```

> \[!TIP]
>
> The animation is automatically disabled when the user prefers reduced motion, the content is displayed statically instead.

### Pause on Hover

Use the `pause-on-hover` prop to pause the animation when the user hovers over the content.

```vue
<template>
  <UMarquee pause-on-hover>
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UMarquee>
</template>
```

### Reverse

Use the `reverse` prop to reverse the direction of the animation.

```vue
<template>
  <UMarquee reverse>
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UMarquee>
</template>
```

### Orientation

Use the `orientation` prop to change the scrolling direction.

```vue
<template>
  <UMarquee orientation="vertical">
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UMarquee>
</template>
```

### Repeat

Use the `repeat` prop to specify how many times the content should be repeated in the animation.

```vue
<template>
  <UMarquee :repeat="6">
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UMarquee>
</template>
```

### Overlay

Use the `overlay` prop to remove the gradient overlays on the edges of the marquee.

```vue
<template>
  <UMarquee :overlay="false">
    <UIcon name="i-simple-icons-github" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-discord" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-x" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-instagram" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-linkedin" class="size-10 shrink-0" />
    <UIcon name="i-simple-icons-facebook" class="size-10 shrink-0" />
  </UMarquee>
</template>
```

## Examples

### Testimonials

Use the `Marquee` component to create an infinite scrolling animation for your testimonials.

```vue [MarqueeTestimonials.vue]
<script setup lang="ts">
import type { UserProps } from "@nuxt/ui";

const testimonials: { user: UserProps; quote: string }[] = [
  {
    user: {
      name: "Anthony Bettini",
      description: "CEO and founder of VulnCheck",
      avatar: {
        src: "https://media.licdn.com/dms/image/v2/C4E03AQEY3pmXsH8hDg/profile-displayphoto-shrink_800_800/profile-displayphoto-shrink_800_800/0/1519741249442?e=1746057600&v=beta&t=dvQfBT9ah03MPNy9cnly30ugreeCdxG4nrxV3lwKAC8",
        loading: "lazy" as const,
      },
    },
    quote:
      "We were using a SaaS service for the docs site, but were left unfulfilled. We put in the effort to do it in house, with UI Pro and not only did we get complimented by a prospect on our site, but they wanted to know our platform.",
  },
  {
    user: {
      name: "Yaz Jallad",
      description: "Founder Ninjaparade Digital",
      avatar: {
        src: "https://pbs.twimg.com/profile_images/1824690890222485504/lQ7v1AGt_400x400.jpg",
        loading: "lazy" as const,
      },
    },
    quote:
      "Wow, Nuxt UI Pro is a total game-changer! I'm seriously impressed with the quality, attention to detail, and the insane variety of components you get. It's like hitting the jackpot for any developer. I've saved countless hours that I would've spent stressing over making my apps look good, with amazing accessible UX,  and instead, I've been able to focus on the real deal – building the app itself. It's an instant buy for me, every single time. No second thoughts!",
  },
  {
    user: {
      name: "Kevin Olson",
      description: "Founder of Fume.app",
      avatar: {
        src: "https://ipx.nuxt.com/f_auto,s_40x40/gh_avatar/acidjazz",
        srcset: "https://ipx.nuxt.com/f_auto,s_80x80/gh_avatar/acidjazz 2x",
        loading: "lazy" as const,
      },
    },
    quote:
      "Nuxt UI Pro saves 100s of hours of dev and design time while delivering a clean professional look on any device.",
  },
  {
    user: {
      name: "Michael Hoffmann",
      description: "Senior Frontend Developer",
      avatar: {
        src: "https://ipx.nuxt.com/f_auto,s_40x40/gh_avatar/mokkapps",
        srcset: "https://ipx.nuxt.com/f_auto,s_80x80/gh_avatar/mokkapps 2x",
        loading: "lazy" as const,
      },
    },
    quote:
      "I decided to replace my custom-built components with a component library and chose Nuxt UI Pro. It only took me a few hours, and the new UI looks more professional. Integrating the library is easy; the components are well-documented and highly customizable. I can only recommend it; this library is my new choice for new SaaS products.",
  },
  {
    user: {
      name: "Harlan Wilton",
      description: "Nuxt core team member",
      avatar: {
        src: "https://ipx.nuxt.com/f_auto,s_40x40/gh_avatar/harlan-zw",
        srcset: "https://ipx.nuxt.com/f_auto,s_80x80/gh_avatar/harlan-zw 2x",
        loading: "lazy" as const,
      },
    },
    quote:
      "Nuxt UI Pro is my go to component library. Out-of-the-box it handles all of the UI demands I throw at it while looking great. The customisation is really worth thought out, allowing you to override components in a breeze. Always amazed at the improvements dropped in each update as well, the team is doing an amazing job.",
  },
  {
    user: {
      name: "Thomas Sanlis",
      description: "Freelance developer and designer",
      avatar: {
        src: "https://pbs.twimg.com/profile_images/1374040164180299791/ACw4G3nZ_400x400.jpg",
        loading: "lazy" as const,
      },
    },
    quote:
      "I jumped at the chance to buy the Nuxt team's new UI kit as soon as I saw it. While I'm already a fan of Nuxt UI, the pro version takes it to a whole new level and lets me paste entire blocks into all my projects, saving me a ton of time.",
  },
  {
    user: {
      name: "Benjamin Code",
      description: "YouTuber and SaaS builder",
      avatar: {
        src: "https://pbs.twimg.com/profile_images/1607353032420769793/I8qQSUfQ_400x400.jpg",
        loading: "lazy" as const,
      },
    },
    quote:
      "Nuxt UI has allowed me to develop my SaaS without any prior mockups. The design quality of their components and the intelligence of the DX meant that I was able to try many different layouts for my application until I found the perfect UX for my users. Nuxt UI is the ui-kit I would have dreamed of building myself, and Nuxt UI Pro makes things even easier when you want to go further with your SaaS. Kudos to the team.",
  },
  {
    user: {
      name: "Estéban Soubiran",
      description: "Web developer and UnJS member",
      avatar: {
        src: "https://pbs.twimg.com/profile_images/1801649350319218689/aS_X_iTm_400x400.jpg",
        loading: "lazy" as const,
      },
    },
    quote:
      "Nuxt UI Pro is my preferred choice for everything, from a POC to a web platform. It's ready to use out-of-the-box and assists me in crafting pixel-perfect UIs. It saves me a significant amount of time while remaining highly customizable. Give it a try, and you won't be let down.",
  },
];
</script>

<template>
  <div class="flex flex-col gap-4 w-full">
    <UMarquee
      pause-on-hover
      :overlay="false"
      :ui="{ root: '[--gap:--spacing(4)]', content: 'w-auto py-1' }"
    >
      <UPageCard
        v-for="(testimonial, index) in testimonials"
        :key="index"
        variant="subtle"
        :description="testimonial.quote"
        :ui="{
          description:
            'before:content-[open-quote] after:content-[close-quote] line-clamp-3',
        }"
        class="w-64 shrink-0"
      >
        <template #footer>
          <UUser
            v-bind="testimonial.user"
            size="xl"
            :ui="{ description: 'line-clamp-1' }"
          />
        </template>
      </UPageCard>
    </UMarquee>
    <UMarquee
      pause-on-hover
      reverse
      :overlay="false"
      :ui="{ root: '[--gap:--spacing(4)]', content: 'w-auto py-1' }"
    >
      <UPageCard
        v-for="(testimonial, index) in testimonials"
        :key="index"
        variant="subtle"
        :description="testimonial.quote"
        :ui="{
          description:
            'before:content-[open-quote] after:content-[close-quote] line-clamp-3',
        }"
        class="w-64 shrink-0"
      >
        <template #footer>
          <UUser
            v-bind="testimonial.user"
            size="xl"
            :ui="{ description: 'line-clamp-1' }"
          />
        </template>
      </UPageCard>
    </UMarquee>
  </div>
</template>
```

### Screenshots

Use the `Marquee` component to create an infinite scrolling animation for your screenshots.

```vue [MarqueeScreenshots.vue]
<template>
  <div class="relative w-full h-[400px] bg-muted overflow-hidden">
    <UMarquee
      reverse
      orientation="vertical"
      :overlay="false"
      :ui="{
        root: '[--duration:40s] absolute w-[460px] -left-[100px] -top-[300px] h-[940px] transform-3d rotate-x-55 rotate-y-0 rotate-z-30',
      }"
    >
      <img
        v-for="i in 4"
        :key="i"
        :src="`/blocks/image${i}.png`"
        width="460"
        height="258"
        :alt="`Nuxt UI Screenshot ${i}`"
        loading="lazy"
        class="aspect-video border border-default rounded-lg bg-white"
      />
    </UMarquee>
    <UMarquee
      orientation="vertical"
      :overlay="false"
      :ui="{
        root: '[--duration:40s] absolute w-[460px] -top-[400px] left-[480px] h-[1160px] transform-3d rotate-x-55 rotate-y-0 rotate-z-30',
      }"
    >
      <img
        v-for="i in [5, 6, 7, 8]"
        :key="i"
        :src="`/blocks/image${i}.png`"
        width="460"
        height="258"
        :alt="`Nuxt UI Screenshot ${i}`"
        loading="lazy"
        class="aspect-video border border-default rounded-lg bg-white"
      />
    </UMarquee>
    <UMarquee
      reverse
      orientation="vertical"
      :overlay="false"
      :ui="{
        root: 'hidden md:flex [--duration:40s] absolute w-[460px] -top-[300px] left-[1020px] h-[1060px] transform-3d rotate-x-55 rotate-y-0 rotate-z-30',
      }"
    >
      <img
        v-for="i in [9, 10, 11, 12]"
        :key="i"
        :src="`/blocks/image${i}.png`"
        width="460"
        height="258"
        :alt="`Nuxt UI Screenshot ${i}`"
        loading="lazy"
        class="aspect-video border border-default rounded-lg bg-white"
      />
    </UMarquee>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
