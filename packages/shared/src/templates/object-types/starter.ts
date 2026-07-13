import type { ObjectTypeTemplate } from "./types";

/**
 * The default starter ontology — the generic primitives a fresh team gets out
 * of the box. These used to be hardcoded system types; they are now a deletable,
 * editable template so a team can keep, reshape, or remove any of them. Only
 * `document` (seeded separately) is truly required.
 *
 * `task` showcases the richer field types: a teammate `assignee` (member), a
 * grouped `status` (kanban lanes), a `progress` bar (number display), and a
 * `due_date`. Keep this set small and industry-agnostic — anything
 * domain-specific belongs in a dedicated template, not here.
 */
export const STARTER_OBJECT_TYPE_TEMPLATE: ObjectTypeTemplate = {
  key: "starter",
  label: "Starter",
  types: [
    {
      key: "company",
      label: "Company",
      labelPlural: "Companies",
      icon: "building-2",
      fields: [
        {
          key: "name",
          label: "Name",
          type: "text",
          isTitle: true,
          displayOrder: 0,
        },
        {
          key: "address",
          label: "Address",
          type: "location",
          config: {},
          displayOrder: 1,
        },
      ],
    },
    {
      key: "note",
      label: "Note",
      labelPlural: "Notes",
      icon: "sticky-note",
      fields: [
        {
          key: "title",
          label: "Title",
          type: "text",
          isTitle: true,
          displayOrder: 0,
        },
        {
          key: "content",
          label: "Content",
          type: "markdown",
          displayOrder: 1,
        },
      ],
    },
    {
      key: "task",
      label: "Task",
      labelPlural: "Tasks",
      icon: "circle-check",
      fields: [
        {
          key: "title",
          label: "Title",
          type: "text",
          isTitle: true,
          displayOrder: 0,
        },
        {
          key: "status",
          label: "Status",
          type: "select",
          config: {
            options: [
              { value: "todo", label: "To do", group: "todo" },
              {
                value: "in_progress",
                label: "In progress",
                group: "in_progress",
              },
              { value: "done", label: "Done", group: "done" },
            ],
          },
          displayOrder: 1,
        },
        {
          key: "assignee",
          label: "Assignee",
          type: "member",
          displayOrder: 2,
        },
        {
          key: "progress",
          label: "Progress",
          type: "number",
          config: {
            display: "bar",
            min: 0,
            max: 100,
            showNumber: true,
          },
          displayOrder: 3,
        },
        {
          key: "due_date",
          label: "Due date",
          type: "date",
          displayOrder: 4,
        },
      ],
    },
  ],
};
