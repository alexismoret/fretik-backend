import {
  isAstNode,
  nodeLine,
  parsePageScript,
  propertyKeyName,
  visitAst,
  type AstNode,
} from "./ast";
import type { PageLintFinding } from "./types";

/**
 * Rows the team's data never produced, presented as if it had.
 *
 * The one defect neither the compiler nor the review can catch. Measured
 * (Langfuse `01a03e9b…`, 2026-08-26): a build over an app the team was not
 * connected to answered `needs_connection` five times, and the page shipped
 * with `populateMockData()` — 78 invented rows, hard-coded company names, and
 * a caption claiming "simulation mode". It rendered beautifully. Every figure
 * on it described nothing, and an operations reader would have acted on them.
 *
 * So this is the one lint that REFUSES a build. The bar for `error` is
 * correspondingly high: a name that says what it is, or a fallback that fills
 * data where the real data failed. Everything softer is a `warning`, because a
 * false error here costs a page that works.
 *
 * What is deliberately NOT a finding: literal arrays under a UI-configuration
 * key (`columns`, `items`, `options`, `tabs`, `links`, `series`) — a table's
 * column list is not data, and flagging it would teach the agent that this
 * channel is noise.
 */

/**
 * A name that says out loud what the array is.
 *
 * Matched on WORD SEGMENTS, not substrings: `populateMockData` is a hit and
 * `seeded` is not. camelCase is normalised to segments first, so one regex
 * covers `mockRows`, `mock_rows` and `populateMockData` without also matching
 * every word that happens to contain "seed".
 */
const FABRICATED_SEGMENT_RE =
  /(?:^|_)(mock|mocks|demo|fake|dummy|sample|samples|fixture|fixtures|placeholder|seed|stub|simulated|simulation|simul)(?:_|$)/;

const segments = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const namesFabrication = (name: string): boolean =>
  FABRICATED_SEGMENT_RE.test(segments(name));

/** Keys whose array value is configuration, not data. */
const UI_CONFIG_KEYS = new Set([
  "columns",
  "items",
  "options",
  "tabs",
  "links",
  "series",
  "labels",
  "datasets",
  "actions",
  "breadcrumbs",
  "steps",
  "fields",
  "slots",
  "plugins",
  "colors",
  "accessorKeys",
]);

/** Rows are objects with fields; two of them is a shape, five is a table. */
const WARN_ROW_COUNT = 5;
const ROW_KEY_COUNT = 3;

const arrayOfRows = (
  node: unknown,
  minimum: number,
): { count: number } | null => {
  if (!isAstNode(node) || node.type !== "ArrayExpression") return null;
  const elements = node["elements"];
  if (!Array.isArray(elements)) return null;
  const objects = elements.filter(
    (element) => isAstNode(element) && element.type === "ObjectExpression",
  );
  if (objects.length < minimum) return null;
  return { count: objects.length };
};

const looksLikeRowTable = (node: unknown): boolean => {
  const rows = arrayOfRows(node, WARN_ROW_COUNT);
  if (rows === null || !isAstNode(node)) return false;
  const elements = node["elements"];
  if (!Array.isArray(elements)) return false;
  return elements.every((element) => {
    if (!isAstNode(element) || element.type !== "ObjectExpression") return true;
    const properties = element["properties"];
    return Array.isArray(properties) && properties.length >= ROW_KEY_COUNT;
  });
};

/** The name a value is being bound to — `const demoRows = …`, `x.value = …`, `mock: …`. */
const boundName = (node: AstNode): string | null => {
  if (node.type === "VariableDeclarator") {
    const id = node["id"];
    if (isAstNode(id) && id.type === "Identifier") {
      const name = id["name"];
      return typeof name === "string" ? name : null;
    }
    return null;
  }
  if (node.type === "AssignmentExpression") {
    const left = node["left"];
    if (!isAstNode(left)) return null;
    if (left.type === "Identifier") {
      const name = left["name"];
      return typeof name === "string" ? name : null;
    }
    if (left.type === "MemberExpression") {
      // `rows.value = […]` — the ref's own name is what says what this is.
      const object = left["object"];
      if (isAstNode(object) && object.type === "Identifier") {
        const name = object["name"];
        return typeof name === "string" ? name : null;
      }
    }
    return null;
  }
  if (node.type === "ObjectProperty") return propertyKeyName(node);
  if (node.type === "FunctionDeclaration") {
    const id = node["id"];
    if (isAstNode(id) && id.type === "Identifier") {
      const name = id["name"];
      return typeof name === "string" ? name : null;
    }
  }
  return null;
};

/** The value being bound, whatever the binding form. */
const boundValue = (node: AstNode): unknown =>
  node.type === "VariableDeclarator"
    ? node["init"]
    : node.type === "AssignmentExpression"
      ? node["right"]
      : node.type === "ObjectProperty"
        ? node["value"]
        : undefined;

/** `ref([...])`, `reactive([...])`, `shallowRef([...])` unwrap to their argument. */
const REF_FACTORIES = new Set(["ref", "shallowRef", "reactive", "computed"]);
const unwrapRef = (value: unknown): unknown => {
  if (!isAstNode(value) || value.type !== "CallExpression") return value;
  const callee = value["callee"];
  if (!isAstNode(callee) || callee.type !== "Identifier") return value;
  const name = callee["name"];
  if (typeof name !== "string" || !REF_FACTORIES.has(name)) return value;
  const args = value["arguments"];
  return Array.isArray(args) && args.length > 0 ? args[0] : value;
};

/** Every array literal returned or assigned inside a subtree. */
const filledArrays = (node: unknown): AstNode[] => {
  const found: AstNode[] = [];
  visitAst(node, (inner) => {
    if (inner.type === "ReturnStatement") {
      const argument = unwrapRef(inner["argument"]);
      if (arrayOfRows(argument, 2) !== null && isAstNode(argument)) {
        found.push(inner);
      }
      return;
    }
    if (inner.type === "AssignmentExpression") {
      const value = unwrapRef(inner["right"]);
      if (arrayOfRows(value, 2) !== null) found.push(inner);
      return;
    }
    if (inner.type === "CallExpression") {
      // `rows.value.push(...)` inside a catch fills just as effectively.
      const callee = inner["callee"];
      if (!isAstNode(callee) || callee.type !== "MemberExpression") return;
      const method = callee["property"];
      if (!isAstNode(method)) return;
      if (method["name"] !== "push") return;
      const args = inner["arguments"];
      if (
        Array.isArray(args) &&
        args.some((arg) => isAstNode(arg) && arg.type === "ObjectExpression")
      ) {
        found.push(inner);
      }
    }
  });
  return found;
};

/** `rows.length === 0`, `!rows.length`, `rows.length < 1` — the empty check. */
const isEmptyCheck = (node: unknown): boolean => {
  if (!isAstNode(node)) return false;
  if (node.type === "UnaryExpression" && node["operator"] === "!") {
    return isEmptyCheck(node["argument"]);
  }
  if (node.type === "MemberExpression") {
    const property = node["property"];
    return isAstNode(property) && property["name"] === "length";
  }
  if (node.type === "BinaryExpression") {
    const operator = node["operator"];
    if (
      operator !== "===" &&
      operator !== "==" &&
      operator !== "<" &&
      operator !== "<="
    ) {
      return false;
    }
    return isEmptyCheck(node["left"]) || isEmptyCheck(node["right"]);
  }
  return false;
};

export const lintFabricatedRows = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const parsed = parsePageScript(path, source);
  if (parsed === null) return [];
  const { ast, offset } = parsed;
  const findings: PageLintFinding[] = [];
  const at = (node: AstNode): number => {
    const line = nodeLine(node);
    return line > 0 ? line + offset : 0;
  };
  const seen = new Set<number>();
  const push = (finding: PageLintFinding): void => {
    // One line, one finding: a `const mockRows = [...]` inside a
    // `catch` would otherwise be reported twice for the same defect.
    const key = finding.line;
    if (key > 0 && seen.has(key)) return;
    if (key > 0) seen.add(key);
    findings.push(finding);
  };

  visitAst(ast, (node) => {
    // 1. It says what it is.
    const name = boundName(node);
    if (name !== null && namesFabrication(name)) {
      const value = unwrapRef(boundValue(node));
      // Either the name holds the rows, or it names the function that fills
      // them — `populateMockData()` was the measured shape, and an arrow
      // function assigned to a const is how it was written.
      const fills =
        node.type === "FunctionDeclaration"
          ? filledArrays(node["body"]).length > 0
          : isAstNode(value) &&
              (value.type === "ArrowFunctionExpression" ||
                value.type === "FunctionExpression")
            ? filledArrays(value["body"]).length > 0
            : arrayOfRows(value, 2) !== null;
      if (fills) {
        push({
          path,
          line: at(node),
          rule: "fabricated-rows",
          severity: "error",
          message: `\`${name}\` invents rows. A dataset that answers nothing, \`error\` or \`needs_connection\` renders that state and names the dataset — delete this and render the empty state. Rows that are genuinely part of the design belong in an \`inline\` dataset in page.json.`,
        });
        return;
      }
    }

    // 2. A `catch` that fills the page where the real data failed.
    if (node.type === "CatchClause") {
      for (const filler of filledArrays(node["body"])) {
        push({
          path,
          line: at(filler),
          rule: "fabricated-rows",
          severity: "error",
          message:
            "A `catch` that fills rows turns a failed query into a page that looks like it worked. Render the failure and name the dataset instead.",
        });
      }
      return;
    }

    // 3. A "no rows? here are some" fallback.
    if (node.type === "IfStatement" && isEmptyCheck(node["test"])) {
      for (const filler of filledArrays(node["consequent"])) {
        push({
          path,
          line: at(filler),
          rule: "fabricated-rows",
          severity: "error",
          message:
            "Rows substituted when the dataset came back empty. An empty dataset is a legitimate state of a working page: say which one is empty and what would fill it.",
        });
      }
      return;
    }

    // 4. A table of rows written by hand, under a key that is not configuration.
    if (
      node.type === "VariableDeclarator" ||
      node.type === "ObjectProperty" ||
      node.type === "AssignmentExpression"
    ) {
      const key = boundName(node);
      if (key !== null && UI_CONFIG_KEYS.has(key)) return;
      const value = unwrapRef(boundValue(node));
      if (!looksLikeRowTable(value)) return;
      const rows = arrayOfRows(value, WARN_ROW_COUNT);
      push({
        path,
        line: at(node),
        rule: "hardcoded-rows",
        severity: "warning",
        message: `${(rows?.count ?? 0).toString()} objects written by hand${key === null ? "" : ` in \`${key}\``} — if these are data, they belong in a dataset; if they are part of the design, declare them as an \`inline\` dataset so the page says so.`,
      });
    }
  });

  return findings;
};
