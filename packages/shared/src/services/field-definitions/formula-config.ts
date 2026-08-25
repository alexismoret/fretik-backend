import { and, eq, isNull, ne } from "drizzle-orm";
import db, { type Executor } from "../../db";
import type { FieldDefinition, FieldDefinitionConfig } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { FormulaError } from "../collection-schema/formula/ast";
import { compileFormula } from "../collection-schema/formula/compile";

/**
 * Validation and result-type inference for `formula` fields.
 *
 * Separate from `validateFieldDefinitionShape` because a formula is the one
 * config that cannot be judged on its own: it is only meaningful against the
 * type's OTHER fields, which means a database read, which means async. Keeping
 * it here leaves that validator synchronous for every other type.
 *
 * The sibling set is read INSIDE the caller's transaction, never from the
 * field-definition cache: a formula added in the same request as the field it
 * reads would otherwise compile against a stale catalog and be refused for
 * naming a field that exists.
 */

/**
 * The type's fields as a formula may see them: same collection, same scope, and
 * (when updating) with the field being edited replaced by its new definition —
 * so a formula that references itself is caught by the cycle detector rather
 * than resolving against its own previous version.
 */
export const readFormulaSiblings = async (input: {
  exec?: Executor;
  collectionId: string;
  teamId: string | null;
  excludeFieldId?: string;
}): Promise<FieldDefinition[]> => {
  const exec = input.exec ?? db;
  const conditions = [
    eq(fieldDefinitions.collectionId, input.collectionId),
    input.teamId === null
      ? isNull(fieldDefinitions.teamId)
      : eq(fieldDefinitions.teamId, input.teamId),
  ];
  if (input.excludeFieldId) {
    conditions.push(ne(fieldDefinitions.id, input.excludeFieldId));
  }
  return await exec
    .select()
    .from(fieldDefinitions)
    .where(and(...conditions));
};

/** Formula source carried on a config, if any. */
export const formulaExpressionOf = (
  config: FieldDefinitionConfig,
): string | undefined =>
  "expression" in config && typeof config.expression === "string"
    ? config.expression
    : undefined;

/**
 * Compile a formula config and return it with `resultType` filled in.
 *
 * The result type is INFERRED, never taken from the caller: it decides the
 * physical column type, so a hand-declared one that disagrees with the
 * expression would be a column the database refuses to build — or worse, builds
 * with the wrong type and silently coerces. The compiler is the only authority.
 *
 * A refusal is a 400 naming the problem and where it is, because three different
 * readers act on it: the person typing in the formula editor, the agent calling
 * `manageField`, and whoever reads the failure in a log.
 */
export const resolveFormulaConfig = (input: {
  config: FieldDefinitionConfig | undefined;
  siblings: FieldDefinition[];
  label: string;
}): FieldDefinitionConfig => {
  const config = input.config ?? {};
  const source = formulaExpressionOf(config);
  if (!source || source.trim().length === 0) {
    return throwHttpError(
      400,
      badRequest(
        `\`${input.label}\` is a formula field, so it needs \`config.expression\` — for example \`revenue - cost\`.`,
      ),
    );
  }

  try {
    const { resultType } = compileFormula({ source, fields: input.siblings });
    return { ...config, resultType };
  } catch (error) {
    if (error instanceof FormulaError) {
      return throwHttpError(
        400,
        badRequest(
          `Formula for \`${input.label}\` (at character ${String(error.at + 1)}): ${error.message}`,
        ),
      );
    }
    throw error;
  }
};

/**
 * Formula fields of a type that read `key`, with `key` itself excluded.
 *
 * Drives the refusals on delete and rename. Without it, deleting a referenced
 * field surfaces Postgres' own "cannot drop column … because other objects
 * depend on it" — which names a COLUMN and a dependency the person has no way
 * to map back to the formula they need to edit. A rename is worse: Postgres
 * silently rewrites the generated expression, leaving the stored formula TEXT
 * pointing at a field key that no longer exists, so the column keeps working
 * until the next time anyone edits it.
 */
export const formulasDependingOn = (input: {
  key: string;
  fields: FieldDefinition[];
}): FieldDefinition[] =>
  input.fields.filter((candidate) => {
    if (candidate.type !== "formula" || candidate.key === input.key) {
      return false;
    }
    const source = formulaExpressionOf(candidate.config);
    if (!source) return false;
    try {
      return compileFormula({
        source,
        fields: input.fields,
      }).dependsOn.includes(input.key);
    } catch {
      // A formula that no longer compiles cannot be shown to depend on
      // anything — and it must not block a change that might be what FIXES it.
      return false;
    }
  });

/**
 * Every formula that must be REBUILT when `key`'s own formula changes, in
 * dependency order (a formula always comes after the ones it reads).
 *
 * This exists because inlining has a cost that only shows up here: a formula
 * reading another one carries a COPY of its SQL, so editing the inner formula
 * leaves the outer column computing the old thing. Measured on a real type —
 * editing `margin` to `(revenue - cost) * 2` doubled `margin`, and left
 * `margin_pct` still dividing by the old margin. The numbers stayed plausible,
 * which is what makes it worth walking the graph rather than hoping.
 *
 * Transitive: a third formula reading `margin_pct` is just as stale.
 */
export const formulasToRebuildAfter = (input: {
  key: string;
  fields: FieldDefinition[];
}): FieldDefinition[] => {
  const ordered: FieldDefinition[] = [];
  const queued = new Set([input.key]);
  let frontier = [input.key];
  // Breadth-first from the changed field: each round collects the formulas that
  // read anything found in the previous one, so a formula is always rebuilt
  // after whatever it inlines.
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const dependent of formulasDependingOn({
        key,
        fields: input.fields,
      })) {
        if (queued.has(dependent.key)) continue;
        queued.add(dependent.key);
        ordered.push(dependent);
        next.push(dependent.key);
      }
    }
    frontier = next;
  }
  return ordered;
};

/**
 * Refuse a change that would break a formula, naming the formulas at fault.
 * No-op when nothing depends on the field.
 */
export const assertNoFormulaDependents = (input: {
  key: string;
  label: string;
  fields: FieldDefinition[];
  action: string;
}): void => {
  const dependents = formulasDependingOn({
    key: input.key,
    fields: input.fields,
  });
  if (dependents.length === 0) return;
  const names = dependents.map((d) => `\`${d.label}\``).join(", ");
  return throwHttpError(
    400,
    badRequest(
      `Cannot ${input.action} \`${input.label}\`: the formula field${dependents.length > 1 ? "s" : ""} ${names} read${dependents.length > 1 ? "" : "s"} it. Update ${dependents.length > 1 ? "those formulas" : "that formula"} first.`,
    ),
  );
};
