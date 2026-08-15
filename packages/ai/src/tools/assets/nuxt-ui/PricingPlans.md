# UPricingPlans

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PricingPlans component
 */
interface PricingPlansProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  plans?: PricingPlanProps[] | undefined;
  /**
   * The orientation of the pricing plans.
   * @default 'horizontal'
   */
  orientation?: "horizontal" | "vertical" | undefined;
  /**
   * When `true`, the plans will be displayed without gap.
   * @default false
   */
  compact?: boolean | undefined;
  /**
   * When `true`, the plans will be displayed with a larger gap.
   * Useful when one plan is scaled. Doesn't work with `compact`.
   * @default false
   */
  scale?: boolean | undefined;
  ui?: { base?: any } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PricingPlans component
 */
interface PricingPlansSlots {
  badge(): any;
  title(): any;
  description(): any;
  price(): any;
  discount(): any;
  billing(): any;
  features(): any;
  button(): any;
  header(): any;
  body(): any;
  footer(): any;
  tagline(): any;
  terms(): any;
  default(): any;
}
```

## Usage

The PricingPlans component provides a flexible layout to display a list of [PricingPlan](https://ui.nuxt.com/docs/components/pricing-plan) components using either the default slot or the `plans` prop.

```vue {2,8}
<template>
  <UPricingPlans>
    <UPricingPlan v-for="(plan, index) in plans" :key="index" v-bind="plan" />
  </UPricingPlans>
</template>
```

> \[!TIP]
>
> The grid columns will be automatically calculated based on the number of plans, this works with the `plans` prop but also with the default slot.

### Plans

Use the `plans` prop as an array of objects with the properties of the [PricingPlan](https://ui.nuxt.com/docs/components/pricing-plan#props) component.

```vue
<script setup lang="ts">
import type { PricingPlanProps } from "@nuxt/ui";

const plans = ref<PricingPlanProps[]>([
  {
    title: "Solo",
    description: "Tailored for indie hackers.",
    price: "$249",
    features: ["One developer", "Lifetime access"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Startup",
    description: "Best suited for small teams.",
    price: "$499",
    features: ["Up to 5 developers", "Everything in Solo"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Organization",
    description: "Ideal for larger teams and organizations.",
    price: "$999",
    features: ["Up to 20 developers", "Everything in Startup"],
    button: {
      label: "Buy now",
    },
  },
]);
</script>

<template>
  <UPricingPlans :plans="plans" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the PricingPlans. Defaults to `horizontal`.

```vue
<script setup lang="ts">
import type { PricingPlanProps } from "@nuxt/ui";

const plans = ref<PricingPlanProps[]>([
  {
    title: "Solo",
    description: "Tailored for indie hackers.",
    price: "$249",
    features: ["One developer", "Lifetime access"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Startup",
    description: "Best suited for small teams.",
    price: "$499",
    features: ["Up to 5 developers", "Everything in Solo"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Organization",
    description: "Ideal for larger teams and organizations.",
    price: "$999",
    features: ["Up to 20 developers", "Everything in Startup"],
    button: {
      label: "Buy now",
    },
  },
]);
</script>

<template>
  <UPricingPlans orientation="vertical" :plans="plans" />
</template>
```

> \[!TIP]
>
> When using the `plans` prop instead of the default slot, the `orientation` of the plans is automatically reversed, `horizontal` to `vertical` and vice versa.

### Compact

Use the `compact` prop to reduce the padding between the plans when one of the plans is scaled for a better visual balance.

```vue
<script setup lang="ts">
import type { PricingPlanProps } from "@nuxt/ui";

const plans = ref<PricingPlanProps[]>([
  {
    title: "Solo",
    description: "Tailored for indie hackers.",
    price: "$249",
    features: ["One developer", "Lifetime access"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Startup",
    description: "Best suited for small teams.",
    price: "$499",
    scale: true,
    features: ["Up to 5 developers", "Everything in Solo"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Organization",
    description: "Ideal for larger teams and organizations.",
    price: "$999",
    features: ["Up to 20 developers", "Everything in Startup"],
    button: {
      label: "Buy now",
    },
  },
]);
</script>

<template>
  <UPricingPlans compact :plans="plans" />
</template>
```

### Scale

Use the `scale` prop to adjust the spacing between the plans when one of the plans is scaled for a better visual balance.

```vue
<script setup lang="ts">
import type { PricingPlanProps } from "@nuxt/ui";

const plans = ref<PricingPlanProps[]>([
  {
    title: "Solo",
    description: "Tailored for indie hackers.",
    price: "$249",
    features: ["One developer", "Lifetime access"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Startup",
    description: "Best suited for small teams.",
    price: "$499",
    scale: true,
    features: ["Up to 5 developers", "Everything in Solo"],
    button: {
      label: "Buy now",
    },
  },
  {
    title: "Organization",
    description: "Ideal for larger teams and organizations.",
    price: "$999",
    features: ["Up to 20 developers", "Everything in Startup"],
    button: {
      label: "Buy now",
    },
  },
]);
</script>

<template>
  <UPricingPlans scale :plans="plans" />
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

> \[!NOTE]
>
> While these examples use [Nuxt Content](https://content.nuxt.com){rel="&#x22;nofollow&#x22;"}, the components can be integrated with any content management system.

### Within a page

Use the PricingPlans component in a page to create a pricing page:

```vue [pages/pricing/index.vue] {11}
<script setup lang="ts">
const { data: plans } = await useAsyncData("plans", () =>
  queryCollection("plans").all(),
);
</script>

<template>
  <UPage>
    <UPageHero title="Pricing" />

    <UPageBody>
      <UContainer>
        <UPricingPlans :plans="plans" />
      </UContainer>
    </UPageBody>
  </UPage>
</template>
```

> \[!NOTE]
>
> In this example, the `plans` are fetched using `queryCollection` from the `@nuxt/content` module.
