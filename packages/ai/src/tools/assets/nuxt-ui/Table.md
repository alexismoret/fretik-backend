# UTable

> Nuxt UI v4 — https://ui.nuxt.com (MIT). Generated, do not edit by hand.

## API

### Props

```ts
/**
 * Props for the Table component
 */
interface TableProps {
  /**
   * The element or component this component should render as.
   * @default 'div'
   */
  as?: any;
  data?: T[] | undefined;
  columns?: TableColumn<T, unknown>[] | undefined;
  caption?: string | undefined;
  /**
   * You can pass any object to `options.meta` and access it anywhere the `table` is available via `table.options.meta`.
   */
  meta?: TableMeta<T> | undefined;
  /**
   * Enable virtualization for large datasets.
   * Note: row pinning is not supported when virtualization is enabled.
   * @default false
   */
  virtualize?: boolean | (Partial<Omit<VirtualizerOptions<Element, Element>, "count" | "estimateSize" | "overscan">> & { getScrollElement?: (() => Element | null) | undefined; overscan?: number | undefined; estimateSize?: number | ((index: number) => number) | undefined; }) | undefined;
  /**
   * The text to display when the table is empty.
   * @default t('table.noData')
   */
  empty?: string | undefined;
  /**
   * Whether the table should have a sticky header or footer. True for both, 'header' for header only, 'footer' for footer only.
   * @default false
   */
  sticky?: boolean | "header" | "footer" | undefined;
  /**
   * Whether the table should be in loading state.
   */
  loading?: boolean | undefined;
  /**
   * @default 'primary'
   */
  loadingColor?: "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral" | undefined;
  /**
   * @default 'carousel'
   */
  loadingAnimation?: "carousel" | "carousel-inverse" | "swing" | "elastic" | undefined;
  /**
   * Use the `watchOptions` prop to customize reactivity (for ex: disable deep watching for changes in your data or limiting the max traversal depth). This can improve performance by reducing unnecessary re-renders, but it should be used with caution as it may lead to unexpected behavior if not managed properly.
   * @default {
    deep: true
}
   */
  watchOptions?: WatchOptions<boolean> | undefined;
  globalFilterOptions?: Omit<GlobalFilterOptions<T>, "onGlobalFilterChange"> | undefined;
  columnFiltersOptions?: Omit<ColumnFiltersOptions<T>, "getFilteredRowModel" | "onColumnFiltersChange"> | undefined;
  columnPinningOptions?: Omit<ColumnPinningOptions, "onColumnPinningChange"> | undefined;
  columnSizingOptions?: Omit<ColumnSizingOptions, "onColumnSizingChange" | "onColumnSizingInfoChange"> | undefined;
  visibilityOptions?: Omit<VisibilityOptions, "onColumnVisibilityChange"> | undefined;
  sortingOptions?: Omit<SortingOptions<T>, "getSortedRowModel" | "onSortingChange"> | undefined;
  groupingOptions?: Omit<GroupingOptions, "onGroupingChange"> | undefined;
  expandedOptions?: Omit<ExpandedOptions<T>, "getExpandedRowModel" | "onExpandedChange"> | undefined;
  rowSelectionOptions?: Omit<RowSelectionOptions<T>, "onRowSelectionChange"> | undefined;
  rowPinningOptions?: Omit<RowPinningOptions<T>, "onRowPinningChange"> | undefined;
  paginationOptions?: Omit<PaginationOptions, "onPaginationChange"> | undefined;
  facetedOptions?: FacetedOptions<T> | undefined;
  onSelect?: (e: Event, row: TableRow<T>): void | undefined;
  onHover?: (e: Event, row: TableRow<T> | null): void | undefined;
  onContextmenu?: (e: Event, row: TableRow<T>): void | ((e: Event, row: TableRow<T>) => void)[] | undefined;
  ui?: { root?: SlotClass; base?: SlotClass; caption?: SlotClass; thead?: SlotClass; tbody?: SlotClass; tfoot?: SlotClass; tr?: SlotClass; th?: SlotClass; td?: SlotClass; separator?: SlotClass; empty?: SlotClass; loading?: SlotClass; } | undefined;
  state?: Partial<TableState> | undefined;
  onStateChange?: (updater: Updater<TableState>): void | undefined;
  renderFallbackValue?: any;
  /**
   * An array of extra features that you can add to the table instance.
   */
  _features?: TableFeature<any>[] | undefined;
  /**
   * Set this option to override any of the `autoReset...` feature options.
   */
  autoResetAll?: boolean | undefined;
  /**
   * Set this option to `true` to output all debugging information to the console.
   */
  debugAll?: boolean | undefined;
  /**
   * Set this option to `true` to output cell debugging information to the console.
   */
  debugCells?: boolean | undefined;
  /**
   * Set this option to `true` to output column debugging information to the console.
   */
  debugColumns?: boolean | undefined;
  /**
   * Set this option to `true` to output header debugging information to the console.
   */
  debugHeaders?: boolean | undefined;
  /**
   * Set this option to `true` to output row debugging information to the console.
   */
  debugRows?: boolean | undefined;
  /**
   * Set this option to `true` to output table debugging information to the console.
   */
  debugTable?: boolean | undefined;
  /**
   * Default column options to use for all column defs supplied to the table.
   */
  defaultColumn?: Partial<ColumnDefBase<T, unknown> & StringHeaderIdentifier> | Partial<ColumnDefBase<T, unknown> & IdIdentifier<T, unknown>> | Partial<GroupColumnDefBase<T, unknown> & StringHeaderIdentifier> | Partial<GroupColumnDefBase<T, unknown> & IdIdentifier<T, unknown>> | Partial<AccessorKeyColumnDefBase<T, unknown> & Partial<StringHeaderIdentifier>> | Partial<AccessorKeyColumnDefBase<T, unknown> & Partial<IdIdentifier<T, unknown>>> | Partial<AccessorFnColumnDefBase<T, unknown> & StringHeaderIdentifier> | Partial<AccessorFnColumnDefBase<T, unknown> & IdIdentifier<T, unknown>> | undefined;
  /**
   * This optional function is used to derive a unique ID for any given row. If not provided the rows index is used (nested rows join together with `.` using their grandparents' index eg. `index.index.index`). If you need to identify individual rows that are originating from any server-side operations, it's suggested you use this function to return an ID that makes sense regardless of network IO/ambiguity eg. a userId, taskId, database ID field, etc.
   */
  getRowId?: (originalRow: T, index: number, parent?: Row<T> | undefined): string | undefined;
  /**
   * This optional function is used to access the sub rows for any given row. If you are using nested rows, you will need to use this function to return the sub rows object (or undefined) from the row.
   */
  getSubRows?: (originalRow: T, index: number): T[] | undefined | undefined;
  /**
   * Use this option to optionally pass initial state to the table. This state will be used when resetting various table states either automatically by the table (eg. `options.autoResetPageIndex`) or via functions like `table.resetRowSelection()`. Most reset function allow you optionally pass a flag to reset to a blank/default state instead of the initial state.
   * 
   * Table state will not be reset when this object changes, which also means that the initial state object does not need to be stable.
   */
  initialState?: InitialTableState | undefined;
  /**
   * This option is used to optionally implement the merging of table options.
   */
  mergeOptions?: (defaultOptions: TableOptions<T>, options: Partial<TableOptions<T>>): TableOptions<T> | undefined;
  cellpadding?: string | number | undefined;
  cellspacing?: string | number | undefined;
  summary?: string | undefined;
  width?: string | number | undefined;
  globalFilter?: string | undefined;
  columnFilters?: ColumnFiltersState | undefined;
  columnOrder?: ColumnOrderState | undefined;
  columnVisibility?: VisibilityState | undefined;
  columnPinning?: ColumnPinningState | undefined;
  columnSizing?: ColumnSizingState | undefined;
  columnSizingInfo?: ColumnSizingInfoState | undefined;
  rowSelection?: RowSelectionState | undefined;
  rowPinning?: RowPinningState | undefined;
  sorting?: SortingState | undefined;
  grouping?: GroupingState | undefined;
  expanded?: true | Record<string, boolean> | undefined;
  pagination?: PaginationState | undefined;
}
```

> [!NOTE]
> See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table#attributes
> 
> This component also supports all native `<table>` HTML attributes.

### Slots

```ts
/**
 * Slots for the Table component
 */
interface TableSlots {
  expanded(): any;
  empty(): any;
  loading(): any;
  caption(): any;
  body-top(): any;
  body-bottom(): any;
}
```

### Expose

You can access the typed component instance using [`useTemplateRef`](https://vuejs.org/api/composition-api-helpers.html#usetemplateref).

```vue
<script setup lang="ts">
const table = useTemplateRef('table')
</script>

<template>
  <UTable ref="table" />
</template>
```

This will give you access to the following:

| Name | Type |
| --- | --- |
| `tableRef` | `Ref<HTMLTableElement \| null>` |
| `tableApi` | [`Table`](https://tanstack.com/table/v8/docs/api/core/table#table-api) |

## Composition

Parts placed by name: `#expanded`, `#empty`, `#loading`, `#caption`, `#body-top`, `#body-bottom`.

Also written in the docs and absent from the interface above — one per column or item: `#title-cell`, `#content`, `#name-cell`, `#action-cell`.

## Usage

The Table component is built on top of [TanStack Table v8](https://tanstack.com/table/v8) and is powered by the [useVueTable](https://tanstack.com/table/v8/docs/framework/vue/vue-table#usevuetable) composable to provide a flexible and fully type-safe API.

It renders your data as rows and columns and supports sorting, filtering, pagination, row selection, expansion, grouping, pinning and virtualization, so you can build everything from a simple data table to a fully featured data grid.

```vue [TableExample.vue]
<script setup lang="ts">
import { h, resolveComponent } from 'vue'
import { upperFirst } from 'scule'
import type { TableColumn } from '@nuxt/ui'
import { useClipboard } from '@vueuse/core'

const UButton = resolveComponent('UButton')
const UCheckbox = resolveComponent('UCheckbox')
const UBadge = resolveComponent('UBadge')
const UDropdownMenu = resolveComponent('UDropdownMenu')

const toast = useToast()
const { copy } = useClipboard()

type Payment = {
  id: string
  date: string
  status: 'paid' | 'failed' | 'refunded'
  email: string
  amount: number
}

const data = ref<Payment[]>([{
  id: '4600',
  date: '2024-03-11T15:30:00',
  status: 'paid',
  email: 'james.anderson@example.com',
  amount: 594
}, {
  id: '4599',
  date: '2024-03-11T10:10:00',
  status: 'failed',
  email: 'mia.white@example.com',
  amount: 276
}, {
  id: '4598',
  date: '2024-03-11T08:50:00',
  status: 'refunded',
  email: 'william.brown@example.com',
  amount: 315
}, {
  id: '4597',
  date: '2024-03-10T19:45:00',
  status: 'paid',
  email: 'emma.davis@example.com',
  amount: 529
}, {
  id: '4596',
  date: '2024-03-10T15:55:00',
  status: 'paid',
  email: 'ethan.harris@example.com',
  amount: 639
}, {
  id: '4595',
  date: '2024-03-10T13:40:00',
  status: 'refunded',
  email: 'ava.thomas@example.com',
  amount: 428
}, {
  id: '4594',
  date: '2024-03-10T09:15:00',
  status: 'paid',
  email: 'michael.wilson@example.com',
  amount: 683
}, {
  id: '4593',
  date: '2024-03-09T20:25:00',
  status: 'failed',
  email: 'olivia.taylor@example.com',
  amount: 947
}, {
  id: '4592',
  date: '2024-03-09T18:45:00',
  status: 'paid',
  email: 'benjamin.jackson@example.com',
  amount: 851
}, {
  id: '4591',
  date: '2024-03-09T16:05:00',
  status: 'paid',
  email: 'sophia.miller@example.com',
  amount: 762
}, {
  id: '4590',
  date: '2024-03-09T14:20:00',
  status: 'paid',
  email: 'noah.clark@example.com',
  amount: 573
}, {
  id: '4589',
  date: '2024-03-09T11:35:00',
  status: 'failed',
  email: 'isabella.lee@example.com',
  amount: 389
}, {
  id: '4588',
  date: '2024-03-08T22:50:00',
  status: 'refunded',
  email: 'liam.walker@example.com',
  amount: 701
}, {
  id: '4587',
  date: '2024-03-08T20:15:00',
  status: 'paid',
  email: 'charlotte.hall@example.com',
  amount: 856
}, {
  id: '4586',
  date: '2024-03-08T17:40:00',
  status: 'paid',
  email: 'mason.young@example.com',
  amount: 492
}, {
  id: '4585',
  date: '2024-03-08T14:55:00',
  status: 'failed',
  email: 'amelia.king@example.com',
  amount: 637
}, {
  id: '4584',
  date: '2024-03-08T12:30:00',
  status: 'paid',
  email: 'elijah.wright@example.com',
  amount: 784
}, {
  id: '4583',
  date: '2024-03-08T09:45:00',
  status: 'refunded',
  email: 'harper.scott@example.com',
  amount: 345
}, {
  id: '4582',
  date: '2024-03-07T23:10:00',
  status: 'paid',
  email: 'evelyn.green@example.com',
  amount: 918
}, {
  id: '4581',
  date: '2024-03-07T20:25:00',
  status: 'paid',
  email: 'logan.baker@example.com',
  amount: 567
}])

const columns: TableColumn<Payment>[] = [{
  id: 'select',
  header: ({ table }) => h(UCheckbox, {
    'modelValue': table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected(),
    'onUpdate:modelValue': (value: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(!!value),
    'aria-label': 'Select all'
  }),
  cell: ({ row }) => h(UCheckbox, {
    'modelValue': row.getIsSelected(),
    'onUpdate:modelValue': (value: boolean | 'indeterminate') => row.toggleSelected(!!value),
    'aria-label': 'Select row'
  }),
  enableSorting: false,
  enableHiding: false
}, {
  accessorKey: 'id',
  header: '#',
  cell: ({ row }) => `#${row.getValue('id')}`
}, {
  accessorKey: 'date',
  header: 'Date',
  cell: ({ row }) => {
    return new Date(row.getValue('date')).toLocaleString('en-US', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  }
}, {
  accessorKey: 'status',
  header: 'Status',
  cell: ({ row }) => {
    const color = ({
      paid: 'success' as const,
      failed: 'error' as const,
      refunded: 'neutral' as const
    })[row.getValue('status') as string]

    return h(UBadge, { class: 'capitalize', variant: 'subtle', color }, () => row.getValue('status'))
  }
}, {
  accessorKey: 'email',
  header: ({ column }) => {
    const isSorted = column.getIsSorted()

    return h(UButton, {
      color: 'neutral',
      variant: 'ghost',
      label: 'Email',
      icon: isSorted ? (isSorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
      class: '-mx-2.5',
      onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
    })
  },
  meta: {
    class: {
      td: 'lowercase'
    }
  }
}, {
  accessorKey: 'amount',
  header: 'Amount',
  meta: {
    class: {
      th: 'text-right',
      td: 'text-right font-medium'
    }
  },
  cell: ({ row }) => {
    const amount = Number.parseFloat(row.getValue('amount'))
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'EUR'
    }).format(amount)
  }
}, {
  id: 'actions',
  enableHiding: false,
  meta: {
    class: {
      td: 'text-right'
    }
  },
  cell: ({ row }) => {
    const items = [{
      type: 'label',
      label: 'Actions'
    }, {
      label: 'Copy payment ID',
      onSelect() {
        copy(row.original.id)

        toast.add({
          title: 'Payment ID copied to clipboard!',
          color: 'success',
          icon: 'i-lucide-circle-check'
        })
      }
    }, {
      label: row.getIsExpanded() ? 'Collapse' : 'Expand',
      onSelect() {
        row.toggleExpanded()
      }
    }, {
      type: 'separator'
    }, {
      label: 'View customer'
    }, {
      label: 'View payment details'
    }]

    return h(UDropdownMenu, {
      'content': {
        align: 'end'
      },
      items,
      'aria-label': 'Actions dropdown'
    }, () => h(UButton, {
      'icon': 'i-lucide-ellipsis-vertical',
      'color': 'neutral',
      'variant': 'ghost',
      'aria-label': 'Actions dropdown'
    }))
  }
}]

const table = useTemplateRef('table')

function randomize() {
  data.value = [...data.value].sort(() => Math.random() - 0.5)
}
</script>

<template>
  <div class="flex-1 divide-y divide-accented w-full">
    <div class="flex items-center gap-2 px-4 py-3.5 overflow-x-auto">
      <UInput
        :model-value="(table?.tableApi?.getColumn('email')?.getFilterValue() as string)"
        class="max-w-sm min-w-[12ch]"
        placeholder="Filter emails..."
        @update:model-value="table?.tableApi?.getColumn('email')?.setFilterValue($event)"
      />

      <UButton color="neutral" label="Randomize" @click="randomize" />

      <UDropdownMenu
        :items="table?.tableApi?.getAllColumns().filter(column => column.getCanHide()).map(column => ({
          label: upperFirst(column.id),
          type: 'checkbox' as const,
          checked: column.getIsVisible(),
          onUpdateChecked(checked: boolean) {
            table?.tableApi?.getColumn(column.id)?.toggleVisibility(!!checked)
          },
          onSelect(e: Event) {
            e.preventDefault()
          }
        }))"
        :content="{ align: 'end' }"
      >
        <UButton
          label="Columns"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-chevron-down"
          class="ml-auto"
          aria-label="Columns select dropdown"
        />
      </UDropdownMenu>
    </div>

    <UTable
      ref="table"
      :data="data"
      :columns="columns"
      sticky
      class="h-96"
    >
      <template #expanded="{ row }">
        <pre>{{ row.original }}</pre>
      </template>
    </UTable>

    <div class="px-4 py-3.5 text-sm text-muted">
      {{ table?.tableApi?.getFilteredSelectedRowModel().rows.length || 0 }} of
      {{ table?.tableApi?.getFilteredRowModel().rows.length || 0 }} row(s) selected.
    </div>
  </div>
</template>
```

_(truncated — ask for fewer components to see more, or rely on the API block above)_

## Examples

### With row actions

You can add a new column that renders a [DropdownMenu](https://ui.nuxt.com/docs/components/dropdown-menu) component inside the `cell` to render row actions.

```vue [TableRowActionsExample.vue]
<script setup lang="ts">
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { Row } from '@tanstack/vue-table'
import { useClipboard } from '@vueuse/core'

const UButton = resolveComponent('UButton')
const UBadge = resolveComponent('UBadge')
const UDropdownMenu = resolveComponent('UDropdownMenu')

const toast = useToast()
const { copy } = useClipboard()

type Payment = {
  id: string
  date: string
  status: 'paid' | 'failed' | 'refunded'
  email: string
  amount: number
}

const data = ref<Payment[]>([{
  id: '4600',
  date: '2024-03-11T15:30:00',
  status: 'paid',
  email: 'james.anderson@example.com',
  amount: 594
}, {
  id: '4599',
  date: '2024-03-11T10:10:00',
  status: 'failed',
  email: 'mia.white@example.com',
  amount: 276
}, {
  id: '4598',
  date: '2024-03-11T08:50:00',
  status: 'refunded',
  email: 'william.brown@example.com',
  amount: 315
}, {
  id: '4597',
  date: '2024-03-10T19:45:00',
  status: 'paid',
  email: 'emma.davis@example.com',
  amount: 529
}, {
  id: '4596',
  date: '2024-03-10T15:55:00',
  status: 'paid',
  email: 'ethan.harris@example.com',
  amount: 639
}])

const columns: TableColumn<Payment>[] = [{
  accessorKey: 'id',
  header: '#',
  cell: ({ row }) => `#${row.getValue('id')}`
}, {
  accessorKey: 'date',
  header: 'Date',
  cell: ({ row }) => {
    return new Date(row.getValue('date')).toLocaleString('en-US', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  }
}, {
  accessorKey: 'status',
  header: 'Status',
  cell: ({ row }) => {
    const color = ({
      paid: 'success' as const,
      failed: 'error' as const,
      refunded: 'neutral' as const
    })[row.getValue('status') as string]

    return h(UBadge, { class: 'capitalize', variant: 'subtle', color }, () => row.getValue('status'))
  }
}, {
  accessorKey: 'email',
  header: 'Email'
}, {
  accessorKey: 'amount',
  header: 'Amount',
  meta: {
    class: {
      th: 'text-right',
      td: 'text-right font-medium'
    }
  },
  cell: ({ row }) => {
    const amount = Number.parseFloat(row.getValue('amount'))
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'EUR'
    }).format(amount)
  }
}, {
  id: 'actions',
  meta: {
    class: {
      td: 'text-right'
    }
  },
  cell: ({ row }) => {
    return h(UDropdownMenu, {
      'content': {
        align: 'end'
      },
      'items': getRowItems(row),
      'aria-label': 'Actions dropdown'
    }, () => h(UButton, {
      'icon': 'i-lucide-ellipsis-vertical',
      'color': 'neutral',
      'variant': 'ghost',
      'aria-label': 'Actions dropdown'
    }))
  }
}]

function getRowItems(row: Row<Payment>) {
  return [{
    type: 'label',
    label: 'Actions'
  }, {
    label: 'Copy payment ID',
    onSelect() {
      copy(row.original.id)

      toast.add({
        title: 'Payment ID copied to clipboard!',
        color: 'success',
        icon: 'i-lucide-circle-check'
      })
    }
  }, {
    type: 'separator'
  }, {
    label: 'View customer'
  }, {
    label: 'View payment details'
  }]
}
</script>

<template>
  <UTable :data="data" :columns="columns" class="flex-1" />
</template>
```

### With expandable rows


_(truncated — ask for fewer components to see more, or rely on the API block above)_
