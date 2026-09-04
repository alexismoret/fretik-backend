# UTheme

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Theme component
 */
interface ThemeProps {
  /**
   * Per-component prop defaults that flow through `useComponentProps` to
   * every descendant. Each key maps to a partial of that component's props.
   */
  props?: ThemeDefaults | undefined;
  /**
   * Per-component slot class overrides (flat shorthand for `:props.<name>.ui`).
   */
  ui?: ThemeUI | undefined;
}
```

### Slots

```ts
/**
 * Slots for the Theme component
 */
interface ThemeSlots {
  default(): any;
}
```

## Usage

The Theme component overrides default **slot classes** and **props** of all child components without modifying each one individually. It uses Vue's `provide` / `inject` mechanism under the hood, so the overrides apply at any depth.

> [!NOTE]
> 
> The Theme component doesn't render any HTML element, it only provides theme overrides to its children.

**Nuxt:**

> [!TIP]
> 
> For app-level theme configuration, we recommend using the `app.config.ts` file instead.

**Vue:**

> [!TIP]
> 
> For app-level theme configuration, we recommend using the `vite.config.ts` file instead.

### Slot classes

Use the `ui` prop to override slot classes of descendant components. Keys are component names (camelCase) and values are their slot class overrides.

```vue [ThemeUiExample.vue]
<template>
  <UTheme
    :ui="{
      button: {
        base: 'rounded-full'
      }
    }"
  >
    <div class="flex items-center gap-2">
      <UButton label="Button" color="neutral" />
      <UButton label="Button" color="neutral" variant="outline" />
      <UButton label="Button" color="neutral" variant="subtle" />
    </div>
  </UTheme>
</template>
```

### Prop defaults `4.8+`

Use the `props` prop to override the default value of any prop on descendant components. Each key maps to a partial of that component's props.

```vue [ThemePropsExample.vue]
<template>
  <UTheme
    :props="{
      button: { color: 'neutral', variant: 'subtle', size: 'lg' },
      tooltip: { delayDuration: 0, arrow: true }
    }"
  >
    <div class="flex items-center gap-2">
      <UTooltip text="Inherits delayDuration from theme">
        <UButton label="Hover me" />
      </UTooltip>
      <UButton label="With icon" icon="i-lucide-rocket" />
      <UButton label="Square" icon="i-lucide-star" square />
    </div>
  </UTheme>
</template>
```

> [!TIP]
> 
> Explicit props on a component (e.g. `<UButton color="primary" />`) always win over `<UTheme :props>`. Theme defaults only apply when the prop wasn't passed explicitly.

## Examples

### Multiple components

Use different keys in `ui` or `props` to theme multiple component types at once.

```vue [ThemeMultipleExample.vue]
<template>
  <UTheme
    :props="{
      button: { color: 'neutral', variant: 'outline', size: 'lg' },
      input: { size: 'lg' },
      select: { size: 'lg' }
    }"
    :ui="{
      button: { base: 'rounded-full' },
      input: { base: 'rounded-full' },
      select: { base: 'rounded-full' }
    }"
  >
    <div class="flex items-center gap-2">
      <UButton label="Button" />
      <UInput placeholder="Search..." />
      <USelect placeholder="Select" :items="['Item 1', 'Item 2', 'Item 3']" />
    </div>
  </UTheme>
</template>
```

### Nested themes

Nest multiple Theme components to compose overrides. The innermost Theme takes precedence, while unoverridden keys are inherited from the outer Theme.

```vue [ThemeNestedExample.vue]
<template>
  <UTheme
    :ui="{
      button: {
        base: 'rounded-full'
      }
    }"
  >
    <div class="flex flex-col items-start gap-4 border border-muted p-4 rounded-lg">
      <div class="flex items-center gap-2">
        <UButton label="Outer theme" />
        <UButton label="Outer theme" color="neutral" variant="outline" />
      </div>

      <UTheme
        :ui="{
          button: {
            base: 'font-black uppercase'
          }
        }"
      >
        <div class="border border-muted p-4 rounded-lg">
          <div class="flex items-center gap-2">
            <UButton label="Inner theme" />
            <UButton label="Inner theme" color="neutral" variant="outline" />
          </div>
        </div>
      </UTheme>
    </div>
  </UTheme>
</template>
```

### Explicit priority

Explicitly setting any prop (including `ui`) on an individual component always takes priority over the Theme component.

```vue [ThemePriorityExample.vue]
<template>
  <UTheme
    :ui="{
      button: {
        base: 'rounded-full'
      }
    }"
  >
    <div class="flex items-center gap-2">
      <UButton label="Themed" />
      <UButton label="Overridden" :ui="{ base: 'rounded-none' }" />
    </div>
  </UTheme>
</template>
```

### Deep propagation

The overrides are available to all descendant components regardless of how deeply nested they are.

```vue [ThemeDeepExample.vue]
<script setup lang="ts">
import MyButton from './MyButton.vue'
</script>

<template>
  <UTheme
    :ui="{
      button: {
        base: 'rounded-full'
      }
    }"
  >
    <UCard :ui="{ body: 'flex items-center gap-2 sm:flex-row flex-col' }">
      <UButton label="Direct child" />
      <MyButton />
    </UCard>
  </UTheme>
</template>
```

> [!NOTE]
> 
> In this example, `MyButton` is a custom component that renders a `UButton` internally. The theme overrides still apply because they propagate through the entire component tree.

### Form components

Use the Theme component to apply consistent styling across a group of form components.

```vue [ThemeFormExample.vue]
<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = z.object({
  name: z.string().min(2, 'Too short'),
  email: z.email('Invalid email'),
  bio: z.string().optional()
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  name: 'John Doe',
  email: 'john@example.com',
  bio: undefined
})

const toast = useToast()
async function onSubmit(event: FormSubmitEvent<Schema>) {
  toast.add({ title: 'Saved', description: 'Your profile has been updated.', color: 'success' })
  console.log(event.data)
}
</script>

<template>
  <UTheme
    :props="{
      input: { size: 'lg' },
      textarea: { size: 'lg' }
    }"
    :ui="{
      formField: {
        root: 'flex max-sm:flex-col justify-between gap-4',
        wrapper: 'w-full sm:max-w-xs'
      }
    }"
  >
    <UForm :schema="schema" :state="state" class="space-y-4 w-full" @submit="onSubmit">
      <UFormField label="Name" name="name" description="Your public display name.">
        <UInput v-model="state.name" />
      </UFormField>

      <UFormField label="Email" name="email" description="Used for notifications.">
        <UInput v-model="state.email" type="email" />
      </UFormField>

      <UFormField label="Bio" name="bio" description="A short description about yourself.">
        <UTextarea v-model="state.bio" placeholder="Tell us about yourself" />
      </UFormField>

      <div class="flex justify-end">
        <UButton type="submit">
          Save changes
        </UButton>
      </div>
    </UForm>
  </UTheme>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
