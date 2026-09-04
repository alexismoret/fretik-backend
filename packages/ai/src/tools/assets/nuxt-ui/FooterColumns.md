# UFooterColumns

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the FooterColumns component
 */
interface FooterColumnsProps {
  /**
   * The element or component this component should render as.
   * @default 'nav'
   */
  as?: any;
  columns?: FooterColumn<T>[] | undefined;
  ui?: { root?: SlotClass; left?: SlotClass; center?: SlotClass; right?: SlotClass; label?: SlotClass; list?: SlotClass; item?: SlotClass; link?: SlotClass; linkLeadingIcon?: SlotClass; linkLabel?: SlotClass; linkLabelExternalIcon?: SlotClass; } | undefined;
}
```

### Slots

```ts
/**
 * Slots for the FooterColumns component
 */
interface FooterColumnsSlots {
  left(): any;
  default(): any;
  right(): any;
  column-label(): any;
  link(): any;
  link-leading(): any;
  link-label(): any;
  link-trailing(): any;
}
```

## Composition

Parts placed by name: `#left`, `#right`, `#column-label`, `#link`, `#link-leading`, `#link-label`, `#link-trailing`.

Also written in the docs and absent from the interface above — one per column or item: `#top`, `#trailing`.

## Usage

The FooterColumns component renders a list of columns to display in your Footer.

Use it in the `top` slot of the [Footer](https://ui.nuxt.com/docs/components/footer) component:

```vue
<template>
  <UFooter>
    <template #top>
      <UContainer>
        <UFooterColumns />
      </UContainer>
    </template>
  </UFooter>
</template>
```

### Columns

Use the `columns` prop as an array of objects with the following properties:

- `label: string`
- `children?: FooterColumnLink[]`

Each column contains a `children` array of objects that define the links. Each link can have the following properties:

- `label?: string`
- `icon?: string`
- `class?: any`
- `ui?: { item?: ClassNameValue, link?: ClassNameValue, linkLabel?: ClassNameValue, linkLabelExternalIcon?: ClassNameValue, linkLeadingIcon?: ClassNameValue }`

You can pass any property from the [Link](https://ui.nuxt.com/docs/components/link#props) component such as `to`, `target`, etc.

```vue [FooterColumnsExample.vue]
<script setup lang="ts">
import type { FooterColumn } from '@nuxt/ui'

const columns: FooterColumn[] = [{
  label: 'Community',
  children: [{
    label: 'Nuxters',
    to: 'https://nuxters.nuxt.com',
    target: '_blank'
  }, {
    label: 'Video Courses',
    to: 'https://masteringnuxt.com/nuxt3?ref=nuxt',
    target: '_blank'
  }, {
    label: 'Nuxt on GitHub',
    to: 'https://github.com/nuxt',
    target: '_blank'
  }]
}, {
  label: 'Solutions',
  children: [{
    label: 'Nuxt Content',
    to: 'https://content.nuxt.com/',
    target: '_blank'
  }, {
    label: 'Nuxt DevTools',
    to: 'https://devtools.nuxt.com/',
    target: '_blank'
  }, {
    label: 'Nuxt Image',
    to: 'https://image.nuxt.com/',
    target: '_blank'
  }, {
    label: 'Nuxt UI',
    to: 'https://ui.nuxt.com/',
    target: '_blank'
  }]
}]
</script>

<template>
  <UFooterColumns :columns="columns">
    <template #right>
      <UFormField name="email" label="Subscribe to our newsletter" size="lg">
        <UInput type="email" class="w-full">
          <template #trailing>
            <UButton type="submit" size="xs" color="neutral" label="Subscribe" />
          </template>
        </UInput>
      </UFormField>
    </template>
  </UFooterColumns>
</template>
```
