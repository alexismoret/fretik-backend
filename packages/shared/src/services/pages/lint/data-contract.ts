import { eachPageFile } from "../../../schemas/pages";
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
 * The one thing a page's code and its `page.json` must agree on.
 *
 * `run-page-data.ts` executes `definition.datasets` and NOTHING else: a
 * dataset the code describes inline is a dataset the server never runs. On
 * 2026-09-04 a build shipped four dataset configs from `lib/dealsHelper.ts`,
 * declared none of them, passed the gate, and rendered "0 résultat" over a
 * collection of 24 records — while its own summary told the user the dashboard
 * was working. Nothing between the model and the user could see the gap,
 * because every check either looked at the code (which queries) or at the
 * definition (which declares nothing), and never at the two together.
 *
 * So this rule is the only one that needs both, and it is deliberately about
 * the CONTRACT, never about rows:
 *
 *   - code that queries while the page declares no dataset  → `error`
 *   - a dataset id used in code that `page.json` never declares → `error`
 *   - rows that come back empty                             → NOTHING
 *
 * That last line is the point. A collection with no records yet, an external
 * app nobody has connected, a page built the day before the data lands — all
 * legitimate, all of them render an empty state, and none of them is a defect.
 * What is a defect is a page that ASKS for something the server was never told
 * about, which is a question that has one answer regardless of how full the
 * team's database is.
 */

/** Every dataset kind the definition understands, as written in code. */
const DATASET_KINDS = new Set(["collections", "external", "inline"]);

const SDK_QUERY = ["data", "query"];
const SDK_REFETCH = ["data", "refetch"];
const SDK_OPS_RUN = ["ops", "run"];

/** `fretik.data.query` → ["fretik","data","query"]; anything else → null. */
const memberPath = (node: AstNode): string[] | null => {
  const parts: string[] = [];
  let current: unknown = node;
  while (isAstNode(current) && current.type === "MemberExpression") {
    if (current["computed"] === true) return null;
    const property = current["property"];
    if (!isAstNode(property) || property.type !== "Identifier") return null;
    const name = property["name"];
    if (typeof name !== "string") return null;
    parts.unshift(name);
    current = current["object"];
  }
  if (!isAstNode(current) || current.type !== "Identifier") return null;
  const root = current["name"];
  if (typeof root !== "string") return null;
  parts.unshift(root);
  return parts;
};

const endsWith = (path: string[], tail: string[]): boolean =>
  tail.length <= path.length &&
  tail.every((part, index) => path[path.length - tail.length + index] === part);

/** The string value of a property on an object literal, or null. */
const stringProperty = (node: AstNode, key: string): string | null => {
  const properties = node["properties"];
  if (!Array.isArray(properties)) return null;
  for (const property of properties) {
    if (!isAstNode(property) || propertyKeyName(property) !== key) continue;
    const value = property["value"];
    if (!isAstNode(value) || value.type !== "StringLiteral") return null;
    const literal = value["value"];
    return typeof literal === "string" ? literal : null;
  }
  return null;
};

interface FileScan {
  /** `fretik.data.query` / `.refetch` appears at all. */
  queries: { path: string; line: number }[];
  /** `fretik.ops.run` appears at all. */
  runsOperations: boolean;
  /** Dataset descriptors written as object literals in the code. */
  descriptors: { path: string; line: number; id: string; kind: string }[];
  /** Ids named in a literal `datasetIds: ["a", "b"]`. */
  datasetIds: { path: string; line: number; id: string }[];
  /** Operation ids passed as a literal first argument to `fretik.ops.run`. */
  operationIds: { path: string; line: number; id: string }[];
}

const scanFile = (path: string, source: string): FileScan => {
  const scan: FileScan = {
    queries: [],
    runsOperations: false,
    descriptors: [],
    datasetIds: [],
    operationIds: [],
  };
  const parsed = parsePageScript(path, source);
  if (parsed === null) return scan;
  const line = (node: AstNode): number => nodeLine(node) + parsed.offset;

  visitAst(parsed.ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = node["callee"];
      const target = isAstNode(callee) ? memberPath(callee) : null;
      if (target !== null) {
        if (endsWith(target, SDK_QUERY) || endsWith(target, SDK_REFETCH)) {
          scan.queries.push({ path, line: line(node) });
        }
        if (endsWith(target, SDK_OPS_RUN)) {
          scan.runsOperations = true;
          const args = node["arguments"];
          const first = Array.isArray(args) ? args[0] : undefined;
          if (isAstNode(first) && first.type === "StringLiteral") {
            const id = first["value"];
            if (typeof id === "string") {
              scan.operationIds.push({ path, line: line(node), id });
            }
          }
        }
      }
    }

    if (node.type === "ObjectExpression") {
      const kind = stringProperty(node, "kind");
      const id = stringProperty(node, "id");
      if (kind !== null && id !== null && DATASET_KINDS.has(kind)) {
        scan.descriptors.push({ path, line: line(node), id, kind });
      }
    }

    if (
      node.type === "ObjectProperty" &&
      propertyKeyName(node) === "datasetIds"
    ) {
      const value = node["value"];
      if (isAstNode(value) && value.type === "ArrayExpression") {
        const elements = value["elements"];
        if (Array.isArray(elements)) {
          for (const element of elements) {
            if (!isAstNode(element) || element.type !== "StringLiteral")
              continue;
            const id = element["value"];
            if (typeof id === "string") {
              scan.datasetIds.push({ path, line: line(node), id });
            }
          }
        }
      }
    }
  });

  return scan;
};

export interface PageDataContract {
  datasetIds: readonly string[];
  operationIds: readonly string[];
}

/**
 * The code against the contract it was written for.
 *
 * Takes the ids from the DEFINITION rather than reading `page.json` itself, so
 * it judges what the runtime will actually hold — a `page.json` the build
 * rejected declares nothing, whatever it says on disk.
 */
export const lintPageDataContract = (
  code: { source: string; files?: Record<string, string> | undefined },
  contract: PageDataContract,
): PageLintFinding[] => {
  const declaredDatasets = new Set(contract.datasetIds);
  const declaredOperations = new Set(contract.operationIds);
  const findings: PageLintFinding[] = [];
  const scans = eachPageFile(code).map(([path, content]) =>
    scanFile(path, content),
  );

  const queries = scans.flatMap((scan) => scan.queries);
  const descriptors = scans.flatMap((scan) => scan.descriptors);
  const usedIds = [
    ...descriptors.map(({ path, line, id }) => ({ path, line, id })),
    ...scans.flatMap((scan) => scan.datasetIds),
  ];

  for (const used of usedIds) {
    if (declaredDatasets.has(used.id)) continue;
    findings.push({
      path: used.path,
      line: used.line,
      rule: "undeclared-dataset",
      severity: "error",
      message: `dataset "${used.id}" is used here but page.json declares no dataset with that id — the server runs page.json's datasets and nothing else, so this one returns nothing. Declare it in page.json (id, kind, and the rest of its config), and keep the code to its id.`,
    });
  }

  // The blunt case: the page asks the bridge for data without ever having said
  // what data. Reported once, on the first call — a page that queries in five
  // places has one defect, not five.
  const first = queries[0];
  if (
    first !== undefined &&
    declaredDatasets.size === 0 &&
    usedIds.length === 0
  ) {
    findings.push({
      path: first.path,
      line: first.line,
      rule: "undeclared-dataset",
      severity: "error",
      message:
        "this page calls fretik.data.query but page.json declares no datasets. Only declared datasets run: write them into page.json, then query them by id. An empty result is fine — an undeclared one never runs at all.",
    });
  }

  for (const used of scans.flatMap((scan) => scan.operationIds)) {
    if (declaredOperations.has(used.id)) continue;
    findings.push({
      path: used.path,
      line: used.line,
      rule: "undeclared-operation",
      severity: "error",
      message: `operation "${used.id}" is run here but page.json declares no operation with that id — the call will be refused. Declare it in page.json, or drop the control that calls it.`,
    });
  }

  findings.push(...lintClaimedWrites(code, declaredOperations.size > 0));
  return findings.sort((a, b) => a.line - b.line);
};

/**
 * A control that says it saved something the page cannot save.
 *
 * The measured shape: `updateStage()` assigned `deals.value[i].stage` and
 * raised a success toast, over a page with no declared operation. Nothing was
 * written, nothing could have been, and the user was told otherwise — the same
 * lie as an invented row, told by a control instead of by a table.
 *
 * The trigger is narrow on purpose: a ref filled FROM a dataset result, later
 * assigned into. Local UI state (a filter, a selection, an open flag) is
 * untouched by this, and so is any page that declares an operation — once one
 * exists, whether the right one runs is the gate's question, not a lint's.
 */
const lintClaimedWrites = (
  code: { source: string; files?: Record<string, string> | undefined },
  declaresOperations: boolean,
): PageLintFinding[] => {
  if (declaresOperations) return [];
  const findings: PageLintFinding[] = [];

  for (const [path, source] of eachPageFile(code)) {
    const parsed = parsePageScript(path, source);
    if (parsed === null) continue;
    const line = (node: AstNode): number => nodeLine(node) + parsed.offset;

    // Refs whose `.value` is assigned from something that looks like a dataset
    // answer: `x.value = res.rows`, `x.value = response.datasets.deals.rows`.
    const dataRefs = new Set<string>();
    visitAst(parsed.ast, (node) => {
      if (node.type !== "AssignmentExpression") return;
      const left = node["left"];
      const right = node["right"];
      if (!isAstNode(left) || !isAstNode(right)) return;
      const target = memberPath(left);
      if (target === null || target.length !== 2 || target[1] !== "value") {
        return;
      }
      let mentionsRows = false;
      visitAst(right, (inner) => {
        if (inner.type !== "MemberExpression") return;
        const property = inner["property"];
        if (!isAstNode(property)) return;
        if (property["name"] === "rows" || property["name"] === "datasets") {
          mentionsRows = true;
        }
      });
      if (mentionsRows && target[0] !== undefined) dataRefs.add(target[0]);
    });
    if (dataRefs.size === 0) continue;

    visitAst(parsed.ast, (node) => {
      if (node.type !== "AssignmentExpression") return;
      const left = node["left"];
      if (!isAstNode(left) || left.type !== "MemberExpression") return;
      // Walk down to the root identifier, allowing the computed index a row
      // assignment goes through: `deals.value[idx].stage`.
      let current: unknown = left;
      const names: string[] = [];
      while (isAstNode(current) && current.type === "MemberExpression") {
        const property = current["property"];
        if (isAstNode(property) && property.type === "Identifier") {
          const name = property["name"];
          if (typeof name === "string") names.unshift(name);
        }
        current = current["object"];
      }
      if (!isAstNode(current) || current.type !== "Identifier") return;
      const root = current["name"];
      if (typeof root !== "string" || !dataRefs.has(root)) return;
      // `x.value = rows` is the load itself, not a write into a row.
      if (names.length < 2 || names[0] !== "value") return;

      findings.push({
        path,
        line: line(node),
        rule: "claimed-write",
        severity: "blocking",
        message: `this writes into ${root}, which holds rows loaded from a dataset, but page.json declares no operation — the change lives until the next reload and the user is told it was saved. Declare the operation in page.json and call fretik.ops.run, or make the control read-only.`,
      });
    });
  }

  return findings;
};
