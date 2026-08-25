import type {
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema";

/**
 * A field on a starter collection. Generic and English-only (unlike the
 * industry document-field templates, which carry i18n keys) — the starter set
 * is core, not domain-specific. After seeding the field is fully user-editable.
 */
export type StarterField = {
  key: string;
  label: string;
  /** One-line gloss of what the field holds — the AI reads it as ground truth. */
  description?: string;
  type: FieldDefinitionType;
  isTitle?: boolean;
  config?: FieldDefinitionConfig;
  displayOrder: number;
};

/**
 * A starter collection. Seeded `isSystem: false` — fully editable and
 * DELETABLE (unlike the one true system type, `document`). Relation fields are
 * intentionally excluded (they need a team-scoped link-type binding; the
 * starter set is org-template scope).
 */
export type StarterCollection = {
  key: string;
  label: string;
  labelPlural: string;
  icon: string;
  description?: string;
  fields: StarterField[];
};

/** A named bundle of starter collections applied at organization creation. */
export type CollectionTemplate = {
  key: string;
  label: string;
  types: StarterCollection[];
};
