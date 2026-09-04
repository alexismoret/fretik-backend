# Pattern — the detail of one record

A skeleton with REAL wiring. Siblings: `pattern-directory.md`, `pattern-workbench.md`, `pattern-overview.md`, `pattern-board.md`.

Every page that lists something needs one, and it is where a page most often stops short: an overlay opens, the fields are printed as a definition list, and the reader is looking at a database row rather than at the thing it describes.

## What a finished detail has

- **An identity band**: what this is, what state it is in, and what to do about it — the title, the status, and the actions, in the first band and not scattered.
- **Grouped fields**, not one flat list. Three or four groups with headings beat twelve labelled lines, and empty fields are omitted rather than printed blank.
- **Every value formatted through its own descriptor** — a label for an option, a formatter for a number or a date, a component for a person or a link. A raw key, an ISO timestamp or `[object Object]` on this screen is the failure the whole review exists to catch.
- **What it is linked to**, reachable: the related records, each one a target.
- **What happened to it**, when the type carries dated events — a timeline, not a paragraph.
- **At least one verb**, wired to a declared operation. A detail with no action is a page the reader leaves to do the work.

Where it opens is § Where depth opens in the doctrine — a panel while the list matters, a view of its own when the record has an identity somebody would send.

## The pane

```vue
<script setup lang="ts">
const props = defineProps<{ record: DealRow }>();
const emit = defineEmits<{ changed: [] }>();

const saving = ref(false);
const toast = useToast();

const setStage = async (stage: string): Promise<void> => {
  saving.value = true;
  const verdict = await fretik.ops.run("set_stage", {
    variables: { id: props.record.id, stage },
  });
  saving.value = false;
  if (verdict.status === "ok") {
    toast.add({ title: `Moved to ${stage}`, color: "success" });
    emit("changed");
    return;
  }
  toast.add({
    title: verdict.message ?? "That did not go through",
    color: "error",
  });
};
</script>

<template>
  <article class="flex h-full flex-col">
    <!-- Identity: what, what state, what to do. One band. -->
    <header
      class="flex items-start justify-between gap-4 border-b border-default px-5 py-4"
    >
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h2 class="truncate font-display text-xl tracking-tight">
            {{ record.title }}
          </h2>
          <UBadge
            :label="record.stageLabel"
            :color="record.stageColor"
            variant="subtle"
          />
        </div>
        <p class="mt-1 text-sm text-muted">{{ record.subtitle }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <UButton
          label="Mark won"
          color="primary"
          :loading="saving"
          @click="setStage('won')"
        />
        <UDropdownMenu :items="moreActions">
          <UButton
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="ghost"
            aria-label="More actions"
          />
        </UDropdownMenu>
      </div>
    </header>

    <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
      <!-- Grouped fields. Empty ones are absent, not blank. -->
      <section v-for="group in groups" :key="group.label" class="space-y-2">
        <h3 class="text-sm font-medium text-highlighted">{{ group.label }}</h3>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2">
          <template v-for="field in group.fields" :key="field.key">
            <dt class="text-sm text-muted">{{ field.label }}</dt>
            <dd class="text-sm tabular-nums">{{ field.display }}</dd>
          </template>
        </dl>
      </section>

      <!-- Who and what it touches, each one a target. -->
      <section v-if="record.people.length" class="space-y-2">
        <h3 class="text-sm font-medium text-highlighted">People</h3>
        <UUser
          v-for="person in record.people"
          :key="person.id"
          v-bind="person"
          size="sm"
        />
      </section>

      <!-- What happened, on the axis it happened on. -->
      <section v-if="record.events.length" class="space-y-2">
        <h3 class="text-sm font-medium text-highlighted">Activity</h3>
        <UTimeline :items="record.events" size="sm" />
      </section>
    </div>
  </article>
</template>
```

`field.display` is the value already run through its descriptor (`references/data.md` § `fields` is the display dictionary) — never `record[field.key]` straight into the template. `moreActions` holds the rest of the verbs, and anything destructive among them declares `confirm` on its operation so the app asks, not the page.
