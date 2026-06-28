import type {
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema";
import { autoColorAt } from "../../lib/colors/object-colors";

/**
 * Auto-assign a palette color to every select/multi_select option that lacks
 * one — colors are entity decoration the system owns, not something the writer
 * (user, AI, SDK) must supply. Options that already carry a color keep it.
 * No-op for non-option field types. Cycles the chromatic palette by position so
 * sibling options are visually distinct.
 */
export const fillOptionColors = (
  type: FieldDefinitionType,
  config: FieldDefinitionConfig,
): FieldDefinitionConfig => {
  if (type !== "select" && type !== "multi_select") return config;
  if (!("options" in config) || !config.options) return config;
  return {
    ...config,
    options: config.options.map((opt, i) =>
      opt.color ? opt : { ...opt, color: autoColorAt(i) },
    ),
  };
};
