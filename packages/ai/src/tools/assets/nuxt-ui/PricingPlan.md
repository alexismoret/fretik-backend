# UPricingPlan

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PricingPlan component
 */
interface PricingPlanProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Display a badge next to the title.
   * Can be a string or an object.
   * `{ color: 'primary', variant: 'subtle' }`{lang="ts-type"}
   */
  badge?: string | BadgeProps | undefined;
  /**
   * The unit price period that appears next to the price.
   * Typically used to show the recurring interval.
   */
  billingCycle?: string | undefined;
  /**
   * Additional billing context that appears above the billing cycle.
   * Typically used to show the actual billing frequency.
   */
  billingPeriod?: string | undefined;
  /**
   * The current price of the plan.
   * When used with `discount`, this becomes the original price.
   */
  price?: string | undefined;
  /**
   * The discounted price of the plan.
   * When provided, the `price` prop will be displayed as strikethrough.
   */
  discount?: string | undefined;
  /**
   * Display a list of features under the price.
   * Can be an array of strings or an array of objects.
   */
  features?: string[] | PricingPlanFeature[] | undefined;
  /**
   * Display a buy button at the bottom.
   * `{ size: 'lg', block: true }`{lang="ts-type"}
   * Use the `onClick` field to add a click handler.
   */
  button?: ButtonProps | undefined;
  /**
   * Display a tagline highlighting the pricing value proposition.
   */
  tagline?: string | undefined;
  /**
   * Display terms at the bottom.
   */
  terms?: string | undefined;
  /**
   * The orientation of the pricing plan.
   * @default 'vertical'
   */
  orientation?: "vertical" | "horizontal" | undefined;
  /**
   * @default 'outline'
   */
  variant?: "soft" | "solid" | "outline" | "subtle" | undefined;
  /**
   * Display a ring around the pricing plan to highlight it.
   */
  highlight?: boolean | undefined;
  /**
   * Enlarge the plan to make it more prominent.
   */
  scale?: boolean | undefined;
  ui?: { root?: SlotClass; header?: SlotClass; body?: SlotClass; footer?: SlotClass; titleWrapper?: SlotClass; title?: SlotClass; description?: SlotClass; priceWrapper?: SlotClass; price?: SlotClass; discount?: SlotClass; billing?: SlotClass; billingPeriod?: SlotClass; billingCycle?: SlotClass; features?: SlotClass; feature?: SlotClass; featureIcon?: SlotClass; featureTitle?: SlotClass; badge?: SlotClass; button?: SlotClass; tagline?: SlotClass; terms?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PricingPlan component
 */
interface PricingPlanSlots {
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
}
```

## Composition

Parts placed by name: `#badge`, `#price`, `#discount`, `#billing`, `#features`, `#button`, `#body`, `#tagline`, `#terms`.

## Usage

The PricingPlan component provides a flexible way to display a pricing plan with customizable content including title, description, price, features, etc.

```vue
<template>
  <u-pricing-plan :button="{
    label: 'Buy now'
  }" :features="[
    'One developer',
    'Unlimited projects',
    'Access to GitHub repository',
    'Unlimited patch & minor updates',
    'Lifetime access'
  ]" badge="Most popular" billing-cycle="/month" class="w-96" description="For bootstrappers and indie hackers." discount="$199" price="$249" title="Solo" />
</template>
```

> [!TIP]
> See: /docs/components/pricing-plans
> 
> Use the `PricingPlans` component to display multiple pricing plans in a responsive grid layout.

### Title

Use the `title` prop to set the title of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" class="w-96" />
</template>
```

### Description

Use the `description` prop to set the description of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." />
</template>
```

### Badge

Use the `badge` prop to display a [Badge](https://ui.nuxt.com/docs/components/badge) next to the title of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." badge="Most popular" />
</template>
```

You can pass any property from the [Badge](https://ui.nuxt.com/docs/components/badge#props) component to customize it.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." :badge="{
  label: 'Most popular',
  color: 'neutral',
  variant: 'solid'
}" />
</template>
```

### Price

Use the `price` prop to set the price of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" />
</template>
```

### Discount

Use the `discount` prop to set a discounted price that will be displayed alongside the original price (which will be shown with a strikethrough).

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" discount="$199" />
</template>
```

### Billing

Use the `billing-cycle` and/or `billing-period` props to display the billing information of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$9" billing-cycle="/month" billing-period="billed annually" />
</template>
```

### Features

Use the `features` prop as an array of string to display a list of features on the PricingPlan:

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" :features="[
  'One developer',
  'Unlimited projects',
  'Access to GitHub repository',
  'Unlimited patch & minor updates',
  'Lifetime access'
]" />
</template>
```

**Nuxt:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/nuxt#theme
> 
> You can customize this icon globally in your `app.config.ts` under `ui.icons.success` key.

**Vue:**

> [!TIP]
> See: /docs/getting-started/integrations/icons/vue#theme
> 
> You can customize this icon globally in your `vite.config.ts` under `ui.icons.success` key.

You can also pass an array of objects with the following properties:

- `title: string`
- `icon?: string`

```vue
<script setup lang="ts">
import type { PricingPlanFeature } from '@nuxt/ui'

const features = ref<PricingPlanFeature[]>([
  {
    title: "One developer",
    icon: "i-lucide-user"
  },
  {
    title: "Unlimited projects",
    icon: "i-lucide-infinity"
  },
  {
    title: "Access to GitHub repository",
    icon: "i-lucide-github"
  },
  {
    title: "Unlimited patch & minor updates",
    icon: "i-lucide-refresh-cw"
  },
  {
    title: "Lifetime access",
    icon: "i-lucide-clock"
  }
])
</script>

<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" :features="features" />
</template>
```

### Button

Use the `button` prop with any property from the [Button](https://ui.nuxt.com/docs/components/button) component to display a button at the bottom of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" :features="[
  'One developer',
  'Unlimited projects',
  'Access to GitHub repository',
  'Unlimited patch & minor updates',
  'Lifetime access'
]" :button="{
  label: 'Buy now'
}" />
</template>
```

> [!TIP]
> 
> Use the `onClick` field to add a click handler to trigger the plan purchase.

### Variant

Use the `variant` prop to change the variant of the PricingPlan.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" :features="[
  'One developer',
  'Unlimited projects',
  'Access to GitHub repository',
  'Unlimited patch & minor updates',
  'Lifetime access'
]" :button="{
  label: 'Buy now'
}" variant="subtle" />
</template>
```

### Orientation

Use the `orientation` prop to change the orientation of the PricingPlan. Defaults to `vertical`.

```vue
<template>
  <UPricingPlan title="Solo" description="For bootstrappers and indie hackers." price="$249" :features="[
  'One developer',
  'Unlimited projects',
  'Access to GitHub repository',
  'Lifetime access'
]" :button="{
  label: 'Buy now'
}" orientation="horizontal" variant="outline" />
</template>
```

### Tagline


_(truncated — ask for fewer components to see more, or rely on the API block above)_
