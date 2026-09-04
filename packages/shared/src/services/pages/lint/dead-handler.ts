import { parsePageScript, visitAst } from "./ast";
import type { PageLintFinding } from "./types";
import { templateElements } from "./walk-template";

/**
 * An event bound to a name the script never defines.
 *
 * `@clear="clearFilters"` with no `clearFilters` anywhere is a control that
 * does nothing when clicked, and NOTHING else in the pipeline says so: the SFC
 * compiles (the template resolves the name off the render context at runtime),
 * the page mounts, the button is on screen, and the runtime is a PRODUCTION Vue
 * build whose warning strings are stripped — so the "Property was accessed
 * during render but is not defined" line never reaches the console the harness
 * reads. Measured 2026-09-04 on a generated page: a "Clear filters" button in
 * the empty state, inert, shipped.
 *
 * Deliberately narrow. Only a handler whose whole expression is ONE identifier
 * is checked — `@click="doThing"`, never `@click="doThing(row)"` or
 * `@click="open = true"`. A bare identifier there has exactly one legal
 * meaning, a function in scope, so a miss is unambiguous and the rule needs no
 * scope analysis to be right. Anything more (member access, inline statements,
 * template refs, interpolation) belongs to `vue-tsc`, which this project has
 * deliberately not put in the build path.
 */

/** A single JS identifier and nothing else. */
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Vue resolves a handler off the setup scope, so anything the script BINDS
 * counts — a declaration, an import, a function, a destructured name. Collected
 * by name only: this rule asks "does it exist", never "is it the right shape".
 */
const scriptBindings = (path: string, source: string): Set<string> | null => {
  const parsed = parsePageScript(path, source);
  if (parsed === null) return null;
  const names = new Set<string>();
  visitAst(parsed.ast, (node) => {
    // Every `Identifier` inside a declaration position. Over-collecting is the
    // safe direction: a name this set holds that is not really callable costs
    // a missed finding, while a name it lacks costs a false accusation.
    if (
      node.type === "VariableDeclarator" ||
      node.type === "FunctionDeclaration" ||
      node.type === "ClassDeclaration" ||
      node.type.startsWith("ImportSpecifier") ||
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportNamespaceSpecifier" ||
      node.type === "ObjectProperty" ||
      node.type === "RestElement" ||
      node.type === "ArrayPattern"
    ) {
      visitAst(node, (inner) => {
        if (inner.type !== "Identifier") return;
        const name = Reflect.get(inner, "name");
        if (typeof name === "string") names.add(name);
      });
    }
  });
  return names;
};

export const lintDeadHandlers = (
  path: string,
  source: string,
): PageLintFinding[] => {
  if (!path.endsWith(".vue")) return [];
  const bindings = scriptBindings(path, source);
  // Unparseable, or a template-only SFC with no script at all. Either way the
  // compiler owns the verdict and a lint talking over it is noise.
  if (bindings === null) return [];

  const findings: PageLintFinding[] = [];
  const seen = new Set<string>();
  for (const element of templateElements(source)) {
    for (const prop of element.props) {
      // The TEMPLATE ast numbers its node types, unlike the script one, so the
      // shape is read the way `walk-template`'s own helpers read it: by name.
      // `@clear="x"` parses as `{ name: "on", exp: { content: "x" } }`.
      if (typeof prop !== "object" || prop === null) continue;
      if (Reflect.get(prop, "name") !== "on") continue;
      const exp = Reflect.get(prop, "exp");
      if (typeof exp !== "object" || exp === null) continue;
      const content = Reflect.get(exp, "content");
      if (typeof content !== "string") continue;
      const handler = content.trim();
      if (!BARE_IDENTIFIER.test(handler)) continue;
      // `$event` and friends are Vue's own, never the script's.
      if (handler.startsWith("$")) continue;
      if (bindings.has(handler)) continue;
      if (seen.has(handler)) continue;
      seen.add(handler);
      findings.push({
        rule: "dead-handler",
        severity: "error",
        path,
        line: element.line,
        message: `<${element.tag}> binds an event to \`${handler}\`, which this file never defines — the control renders and does nothing when used. Define it, or bind the event to the handler that already exists.`,
      });
    }
  }
  return findings;
};
