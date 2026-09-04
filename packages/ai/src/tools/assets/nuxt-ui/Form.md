# UForm

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Form component
 */
interface FormProps {
  id?: string | number | undefined;
  /**
   * Schema to validate the form state. Supports Standard Schema objects, Yup, Joi, and Superstructs.
   */
  schema?: S | undefined;
  /**
   * An object representing the current state of the form.
   */
  state?: N extends false ? Partial<InferInput<S>> : never | undefined;
  /**
   * Custom validation function to validate the form state.
   */
  validate?: (state: Partial<InferInput<S>>): FormError<string>[] | Promise<FormError<string>[]> | undefined;
  /**
   * The list of input events that trigger the form validation.
   * @default `['blur', 'change', 'input']`
   */
  validateOn?: FormInputEvents[] | undefined;
  /**
   * Disable all inputs inside the form.
   */
  disabled?: boolean | undefined;
  /**
   * The `name` attribute of the form element.
   * For nested forms (`nested` is true), this is also used as the path of the form's state within its parent form.
   */
  name?: string | undefined;
  /**
   * Delay in milliseconds before validating the form on input events.
   * @default 300
   */
  validateOnInputDelay?: number | undefined;
  /**
   * If true, applies schema transformations on submit.
   * @default true as T
   */
  transform?: T | undefined;
  /**
   * If true, this form will attach to its parent Form and validate at the same time.
   * @default `false`
   */
  nested?: N | undefined;
  /**
   * When `true`, all form elements will be disabled on `@submit` event.
   * This will cause any focused input elements to lose their focus state.
   * @default true
   */
  loadingAuto?: boolean | undefined;
  ui?: { base?: any; } | undefined;
  acceptcharset?: string | undefined;
  action?: string | undefined;
  autocomplete?: string | undefined;
  enctype?: string | undefined;
  method?: string | undefined;
  novalidate?: false | true | "true" | "false" | undefined;
  target?: string | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form#attributes
> 
> This component also supports all native `<form>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Form component
 */
interface FormSlots {
  default(): any;
}
```

### Emits

```ts
/**
 * Emitted events for the Form component
 */
interface FormEmits {
  submit: (payload: [event: FormSubmitEvent<FormData<S, T>>]) => void;
  error: (payload: [event: FormErrorEvent]) => void;
}
```

### Expose

You can access the typed component instance using [`useTemplateRef`](https://vuejs.org/api/composition-api-helpers.html#usetemplateref).

```vue
<script setup lang="ts">
const form = useTemplateRef('form')
</script>

<template>
  <UForm ref="form" />
</template>
```

This will give you access to the following:

| Name | Type |
| --- | --- |
| `submit()` | `Promise<void>` <br> Triggers form submission with HTML5 validation. |
| `validate(opts: { name?: keyof T \| (keyof T)[], silent?: boolean, nested?: boolean, transform?: boolean })` | `Promise<T>` <br> Triggers form validation. Will raise any errors unless `opts.silent` is set to true. |
| `clear(path?: keyof T \| RegExp)` | `void` <br> Clears form errors associated with a specific path. If no path is provided, clears all form errors. |
| `getErrors(path?: keyof T \| RegExp)` | `FormErrorWithId[]` <br> Retrieves form errors associated with a specific path. If no path is provided, returns all form errors. |
| `setErrors(errors: FormError[], name?: keyof T \| RegExp)` | `void` <br> Sets form errors for a given path. If no path is provided, overrides all errors. |
| `errors` | `Ref<FormErrorWithId[]>` <br> A reference to the array containing validation errors. Use this to access or manipulate the error information. |
| `disabled` | `Ref<boolean>` |
| `dirty` | `Ref<boolean>` `true` if at least one form field has been updated by the user. |
| `dirtyFields` | `ReadonlySet<DeepReadonly<keyof T>>` Tracks fields that have been modified by the user. |
| `touchedFields` | `ReadonlySet<DeepReadonly<keyof T>>` Tracks fields that the user interacted with. |
| `blurredFields` | `ReadonlySet<DeepReadonly<keyof T>>` Tracks fields blurred by the user. |

## Usage

Use the Form component to validate form data using any validation library supporting [Standard Schema](https://github.com/standard-schema/standard-schema) such as [Valibot](https://github.com/fabian-hiller/valibot), [Zod](https://github.com/colinhacks/zod), [Regle](https://github.com/victorgarciaesgi/regle), [Yup](https://github.com/jquense/yup), [Joi](https://github.com/hapijs/joi) or [Superstruct](https://github.com/ianstormtaylor/superstruct) or your own validation logic.

It works with the [FormField](https://ui.nuxt.com/docs/components/form-field) component to display error messages around form elements automatically.

### Schema validation

It requires two props:

- `state` - a reactive object holding the form's state.
- `schema` - any [Standard Schema](https://github.com/standard-schema/standard-schema) or [Superstruct](https://github.com/ianstormtaylor/superstruct).

> [!WARNING]
> 
> **No validation library is included** by default, ensure you **install the one you need**.

```vue [FormExampleValibot.vue]
<script setup lang="ts">
import * as v from 'valibot'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = v.object({
  email: v.pipe(v.string(), v.email('Invalid email')),
  password: v.pipe(v.string(), v.minLength(8, 'Must be at least 8 characters'))
})

type Schema = v.InferOutput<typeof schema>

const state = reactive({
  email: '',
  password: ''
})

const toast = useToast()
async function onSubmit(event: FormSubmitEvent<Schema>) {
  toast.add({ title: 'Success', description: 'The form has been submitted.', color: 'success' })
  console.log(event.data)
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
    <UFormField label="Email" name="email">
      <UInput v-model="state.email" />
    </UFormField>

    <UFormField label="Password" name="password">
      <UInput v-model="state.password" type="password" />
    </UFormField>

    <UButton type="submit">
      Submit
    </UButton>
  </UForm>
</template>
```

```vue [FormExampleZod.vue]
<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = z.object({
  email: z.email('Invalid email'),
  password: z.string('Password is required').min(8, 'Must be at least 8 characters')
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  email: undefined,
  password: undefined
})

const toast = useToast()
async function onSubmit(event: FormSubmitEvent<Schema>) {
  toast.add({ title: 'Success', description: 'The form has been submitted.', color: 'success' })
  console.log(event.data)
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
    <UFormField label="Email" name="email">
      <UInput v-model="state.email" />
    </UFormField>

    <UFormField label="Password" name="password">
      <UInput v-model="state.password" type="password" />
    </UFormField>

    <UButton type="submit">
      Submit
    </UButton>
  </UForm>
</template>
```

```vue [FormExampleRegle.vue]
<script setup lang="ts">
import { useRegle, type InferInput } from '@regle/core'
import { required, email, minLength, withMessage } from '@regle/rules'
import type { FormSubmitEvent } from '@nuxt/ui'

const { r$ } = useRegle({ email: '', password: '' }, {
  email: { required, email: withMessage(email, 'Invalid email') },
  password: { required, minLength: withMessage(minLength(8), 'Must be at least 8 characters') }
})

type Schema = InferInput<typeof r$>

const toast = useToast()
async function onSubmit(event: FormSubmitEvent<Schema>) {
  toast.add({ title: 'Success', description: 'The form has been submitted.', color: 'success' })
  console.log(event.data)
}
</script>

<template>
  <UForm :schema="r$" :state="r$.$value" class="space-y-4" @submit="onSubmit">
    <UFormField label="Email" name="email">
      <UInput v-model="r$.$value.email" />
    </UFormField>

    <UFormField label="Password" name="password">
      <UInput v-model="r$.$value.password" type="password" />
    </UFormField>

    <UButton type="submit">
      Submit
    </UButton>
  </UForm>
</template>
```

```vue [FormExampleYup.vue]
<script setup lang="ts">
import { object, string } from 'yup'
import type { InferType } from 'yup'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = object({
  email: string().email('Invalid email').required('Required'),
  password: string()
    .min(8, 'Must be at least 8 characters')
    .required('Required')
})

type Schema = InferType<typeof schema>

const state = reactive({
  email: undefined,
  password: undefined
})

const toast = useToast()
async function onSubmit(event: FormSubmitEvent<Schema>) {
  toast.add({ title: 'Success', description: 'The form has been submitted.', color: 'success' })
  console.log(event.data)
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
    <UFormField label="Email" name="email">
      <UInput v-model="state.email" />
    </UFormField>

    <UFormField label="Password" name="password">
      <UInput v-model="state.password" type="password" />
    </UFormField>

    <UButton type="submit">
      Submit
    </UButton>
  </UForm>
</template>
```

```vue [FormExampleJoi.vue]
<script setup lang="ts">
import Joi from 'joi'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = Joi.object({
  email: Joi.string().required(),
  password: Joi.string()
    .min(8)
    .required()
})

const state = reactive({
  email: undefined,
  password: undefined
})

const toast = useToast()
async function onSubmit(event: FormSubmitEvent<typeof state>) {
  toast.add({ title: 'Success', description: 'The form has been submitted.', color: 'success' })
  console.log(event.data)
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
    <UFormField label="Email" name="email">
      <UInput v-model="state.email" />
    </UFormField>

    <UFormField label="Password" name="password">
      <UInput v-model="state.password" type="password" />
    </UFormField>

    <UButton type="submit">
      Submit
    </UButton>
  </UForm>
</template>
```

```vue [FormExampleSuperstruct.vue]
<script setup lang="ts">
import { object, string, nonempty, refine } from 'superstruct'
import type { Infer } from 'superstruct'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = object({
  email: nonempty(string()),
  password: refine(string(), 'Password', (value) => {
    if (value.length >= 8) return true
    return 'Must be at least 8 characters'
  })
})

const state = reactive({
  email: '',
  password: ''
})

type Schema = Infer<typeof schema>

async function onSubmit(event: FormSubmitEvent<Schema>) {
  console.log(event.data)
}
</script>

<template>
  <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
    <UFormField label="Email" name="email">
      <UInput v-model="state.email" />
    </UFormField>

    <UFormField label="Password" name="password">
      <UInput v-model="state.password" type="password" />
    </UFormField>

    <UButton type="submit">
      Submit
    </UButton>
  </UForm>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_
