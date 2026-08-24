# UPricingTable

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the PricingTable component
 */
interface PricingTableProps {
  /**
   * The pricing tiers to display in the table.
   * Each tier represents a pricing plan with its own title, description, price, and features.
   */
  tiers: T[];
  /**
   * The sections of features to display in the table.
   * Each section contains a title and a list of features with their availability in each tier.
   */
  sections: PricingTableSection<T>[];
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  /**
   * The caption to display above the table.
   * @default t('pricingTable.caption')
   */
  caption?: string | undefined;
  ui?:
    | {
        root?: SlotClass;
        table?: SlotClass;
        list?: SlotClass;
        item?: SlotClass;
        caption?: SlotClass;
        thead?: SlotClass;
        tbody?: SlotClass;
        tr?: SlotClass;
        th?: SlotClass;
        td?: SlotClass;
        tier?: SlotClass;
        tierWrapper?: SlotClass;
        tierTitleWrapper?: SlotClass;
        tierTitle?: SlotClass;
        tierDescription?: SlotClass;
        tierBadge?: SlotClass;
        tierPriceWrapper?: SlotClass;
        tierPrice?: SlotClass;
        tierDiscount?: SlotClass;
        tierBilling?: SlotClass;
        tierBillingPeriod?: SlotClass;
        tierBillingCycle?: SlotClass;
        tierButton?: SlotClass;
        tierFeatureIcon?: SlotClass;
        section?: SlotClass;
        sectionTitle?: SlotClass;
        feature?: SlotClass;
        featureTitle?: SlotClass;
        featureValue?: SlotClass;
      }
    | undefined;
}
```

### Slots

```ts
/**
 * Slots for the PricingTable component
 */
interface PricingTableSlots {
  caption(): any;
  tier(): any;
  tier-title(): any;
  tier-description(): any;
  tier-badge(): any;
  tier-button(): any;
  tier-billing(): any;
  tier-discount(): any;
  tier-price(): any;
  section-title(): any;
  feature-title(): any;
  feature-value(): any;
}
```

## Usage

The PricingTable component provides a responsive and customizable way to display pricing plans in a table format, automatically switching between a horizontal table layout on desktop for easy comparison and a vertical card layout on mobile for better readability.

```vue
<template>
  <u-pricing-table :sections=[{"title":"Features","features":[{"title":"Number of developers","tiers":{"solo":"1","team":"5","enterprise":"Unlimited"}},{"title":"Projects","tiers":{"solo":true,"team":true,"enterprise":true}},{"title":"GitHub repository access","tiers":{"solo":true,"team":true,"enterprise":true}},{"title":"Updates","tiers":{"solo":"Patch & minor","team":"All updates","enterprise":"All updates"}},{"title":"Support","tiers":{"solo":"Community","team":"Priority","enterprise":"24/7"}}]},{"title":"Security","features":[{"title":"SSO","tiers":{"solo":false,"team":true,"enterprise":true}},{"title":"Audit logs","tiers":{"solo":false,"team":true,"enterprise":true}},{"title":"Custom security review","tiers":{"solo":false,"team":false,"enterprise":true}}]}] :tiers=[{"id":"solo","title":"Solo","description":"For indie hackers.","price":"$249","billingCycle":"/month","billingPeriod":"billed annually","badge":"Most popular","button":{"label":"Buy now","variant":"subtle"}},{"id":"team","title":"Team","description":"For growing teams.","price":"$499","billingCycle":"/month","billingPeriod":"billed annually","button":{"label":"Buy now"},"highlight":true},{"id":"enterprise","title":"Enterprise","description":"For large organizations.","price":"Custom","button":{"label":"Contact sales","color":"neutral"}}] />
</template>
```

### Tiers

Use the `tiers` prop as an array of objects to define your pricing plans. Each tier object supports the following properties:

- `id: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Unique identifier for the tier (required)
- `title?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Name of the pricing plan
- `description?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Short description of the plan
- `price?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - The current price of the plan (e.g. "$99", "€99", "Free")
- `discount?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - The discounted price that will display the `price` with strikethrough (e.g. "$79", "€79")
- `billingCycle?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - The unit price period that appears next to the price (e.g. "/month", "/seat/month")
- `billingPeriod?: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Additional billing context that appears above the billing cycle (e.g. "billed monthly")
- `badge?: string | BadgeProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Display a badge next to the title `{ color: 'primary', variant: 'subtle' }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `button?: ButtonProps`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Configure the CTA button `{ size: 'lg', block: true }`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}
- `highlight?: boolean`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - Whether to visually emphasize this tier as the recommended option

```vue
<script setup lang="ts">
import type { PricingTableTier } from "@nuxt/ui";

const tiers = ref<PricingTableTier[]>([
  {
    id: "solo",
    title: "Solo",
    description: "For indie hackers.",
    price: "$249",
    billingCycle: "/month",
    billingPeriod: "billed annually",
    badge: "Most popular",
    button: {
      label: "Buy now",
      variant: "subtle",
    },
  },
  {
    id: "team",
    title: "Team",
    description: "For growing teams.",
    price: "$499",
    billingCycle: "/month",
    billingPeriod: "billed annually",
    button: {
      label: "Buy now",
    },
    highlight: true,
  },
  {
    id: "enterprise",
    title: "Enterprise",
    description: "For large organizations.",
    price: "Custom",
    button: {
      label: "Contact sales",
      color: "neutral",
    },
  },
]);
</script>

<template>
  <UPricingTable :tiers="tiers" />
</template>
```

### Sections

Use the `sections` prop to organize features into logical groups. Each section represents a category of features that you want to compare across different pricing tiers.

- `title: string`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"} - The heading for the feature section
- `features: PricingTableSectionFeature[]`{.shiki,shiki-themes,material-theme-lighter,material-theme,material-theme-palenight lang="ts-type"}- An array of features with their availability in each tier:
  - Each feature requires a `title` and a `tiers` object mapping tier IDs to values
  - Boolean values (`true`/`false`) will display as checkmarks (✓) or minus icons (-)
  - String values will be shown as text (e.g. "Unlimited", "Up to 5 users")
  - Numeric values will be displayed as is (e.g. 10, 100)

```vue
<script setup lang="ts">
import type { PricingTableTier, PricingTableSection } from "@nuxt/ui";

const tiers = ref<PricingTableTier[]>([
  {
    id: "solo",
    title: "Solo",
    price: "$249",
    description: "For indie hackers.",
    billingCycle: "/month",
    button: {
      label: "Buy now",
      variant: "subtle",
    },
  },
  {
    id: "team",
    title: "Team",
    price: "$499",
    description: "For growing teams.",
    billingCycle: "/month",
    button: {
      label: "Buy now",
    },
  },
  {
    id: "enterprise",
    title: "Enterprise",
    price: "Custom",
    description: "For large organizations.",
    button: {
      label: "Contact sales",
      color: "neutral",
    },
  },
]);
const sections = ref<PricingTableSection[]>([
  {
    title: "Features",
    features: [
      {
        title: "Number of developers",
        tiers: {
          solo: "1",
          team: "5",
          enterprise: "Unlimited",
        },
      },
      {
        title: "Projects",
        tiers: {
          solo: true,
          team: true,
          enterprise: true,
        },
      },
    ],
  },
  {
    title: "Security",
    features: [
      {
        title: "SSO",
        tiers: {
          solo: false,
          team: true,
          enterprise: true,
        },
      },
    ],
  },
]);
</script>

<template>
  <UPricingTable :tiers="tiers" :sections="sections" />
</template>
```

## Examples

### With slots

The PricingTable component provides powerful slot customization options to tailor the display of your content. You can customize individual elements using generic slots or target specific items using their IDs.

```vue [PricingTableSlotsExample.vue]
<script setup lang="ts">
const tiers = [
  {
    id: "solo",
    title: "Solo",
    price: "$249",
    description: "For indie hackers.",
    billingCycle: "/month",
    button: { label: "Buy now", variant: "subtle" as const },
  },
  {
    id: "team",
    title: "Team",
    price: "$499",
    description: "For growing teams.",
    billingCycle: "/month",
    button: { label: "Buy now" },
    highlight: true,
  },
  {
    id: "enterprise",
    title: "Enterprise",
    price: "Custom",
    description: "For large organizations.",
    button: { label: "Contact sales", color: "neutral" as const },
  },
];

const sections = [
  {
    id: "features",
    title: "Features",
    features: [
      {
        id: "developers",
        title: "Number of developers",
        tiers: { solo: "1", team: "5", enterprise: "Unlimited" },
      },
      {
        id: "projects",
        title: "Projects",
        tiers: { solo: true, team: true, enterprise: true },
      },
    ],
  },
  {
    id: "security",
    title: "Security",
    features: [
      {
        title: "SSO",
        tiers: { solo: false, team: true, enterprise: true },
      },
    ],
  },
];
</script>

<template>
  <UPricingTable :tiers="tiers" :sections="sections">
    <!-- Customize specific tier title -->
    <template #team-title="{ tier }">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-crown" class="size-4 text-amber-500" />
        {{ tier.title }}
      </div>
    </template>

    <!-- Customize specific section title -->
    <template #section-security-title="{ section }">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-shield-check" class="size-4 text-green-500" />
        <span class="font-semibold text-green-700">{{ section.title }}</span>
      </div>
    </template>

    <!-- Customize specific feature value -->
    <template #feature-developers-value="{ feature, tier }">
      <template v-if="feature.tiers?.[tier.id]">
        <UBadge
          :label="String(feature.tiers[tier.id])"
          color="primary"
          variant="soft"
        />
      </template>
      <UIcon v-else name="i-lucide-x" class="size-4 text-muted" />
    </template>
  </UPricingTable>
</template>
```

The component supports various slot types for maximum customization flexibility:

| Slot Type         | Pattern                               | Description             | Example                      |
| ----------------- | ------------------------------------- | ----------------------- | ---------------------------- |
| **Tier slots**    | `#{tier-id}-{element}`                | Target specific tiers   | `#team-title`, `#solo-price` |
| **Section slots** | `#section-{id                         | formatted-title}-title` | Target specific sections     | `#section-features-title` |
| **Feature slots** | `#feature-{id                         | formatted-title}-{title | value}`                      | Target specific features  | `#feature-developers-title` |
| **Generic slots** | `#tier-title`, `#section-title`, etc. | Apply to all items      | `#feature-value`             |

> \[!NOTE]
>
> When no `id` is provided, the slot name is auto-generated from the title (e.g. "Premium Features!" becomes `#section-premium-features-title`).
