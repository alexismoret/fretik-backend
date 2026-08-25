import type { FormulaResultType } from "../../db/schema/field-types";
import type { FormulaNode } from "../collection-schema/formula/ast";
import { FormulaError } from "../collection-schema/formula/ast";
import { compileFormula } from "../collection-schema/formula/compile";
import {
  arityOf,
  FORMULA_FUNCTIONS,
} from "../collection-schema/formula/functions";
import { parseFormula } from "../collection-schema/formula/parse";
import { readFormulaSiblings } from "./formula-config";

/**
 * Dry-run a formula: does it compile against this type's fields, and what does
 * it evaluate to?
 *
 * This is what makes the formula editor usable — without it the author types
 * blind and learns about a mistake from a toast after saving. It runs the SAME
 * `compileFormula` the save path runs, deliberately: a second, more permissive
 * validator would tell people their formula is fine and then refuse it.
 *
 * Never throws for a bad formula — an invalid expression is the NORMAL state
 * while someone is typing one, so it is an outcome, not an error.
 */
export type FormulaCheck =
  | {
      ok: true;
      resultType: FormulaResultType;
      dependsOn: string[];
      /**
       * The parsed tree, so the visual builder can OPEN an existing formula.
       * The builder edits the tree and prints it back to text, which is what is
       * stored — the expression stays the single stored representation, and a
       * formula typed by hand opens in the builder unchanged.
       */
      ast: FormulaNode;
    }
  | { ok: false; message: string; at: number };

export const checkFormula = async (input: {
  collectionId: string;
  teamId: string | null;
  /** The field being edited, so a formula cannot resolve against its old self. */
  excludeFieldId?: string;
  expression: string;
}): Promise<FormulaCheck> => {
  const fields = await readFormulaSiblings({
    collectionId: input.collectionId,
    teamId: input.teamId,
    excludeFieldId: input.excludeFieldId,
  });
  try {
    const { resultType, dependsOn } = compileFormula({
      source: input.expression,
      fields,
    });
    return {
      ok: true,
      resultType,
      dependsOn,
      ast: parseFormula(input.expression),
    };
  } catch (error) {
    if (error instanceof FormulaError) {
      return { ok: false, message: error.message, at: error.at };
    }
    throw error;
  }
};

/**
 * The function catalog the visual builder draws its palette from: every
 * function, its parameters IN ORDER with their names and accepted types, and
 * whether the last one repeats.
 *
 * Served rather than mirrored in the frontend on purpose. The builder renders
 * one labelled slot per parameter and type-hints each one, so a hand-copied
 * list would not just go stale — it would draw a form that does not match the
 * function it claims to build, and the mismatch only surfaces on save.
 */
export const formulaFunctionCatalog = (): {
  name: string;
  hint: string;
  variadic: boolean;
  minArgs: number;
  params: { name: string; type: string }[];
}[] =>
  Object.entries(FORMULA_FUNCTIONS)
    .map(([name, fn]) => ({
      name,
      hint: fn.hint,
      variadic: fn.variadic ?? false,
      minArgs: arityOf(name, fn).min,
      params: fn.params.map((param) => ({
        name: param.name,
        type: param.type,
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
