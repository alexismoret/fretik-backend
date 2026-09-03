import { isAstNode, nodeLine, parsePageScript, visitAst } from "./ast";
import type { PageLintFinding } from "./types";
import { templateElements } from "./walk-template";

/**
 * The Vue mistakes that compile.
 *
 * Each one here renders something plausible and behaves wrongly, which is why
 * a compiler pass cannot replace them: `{{ rows.value }}` prints nothing,
 * `emit("select")` without `defineEmits` is a no-op, and a composable called
 * inside a handler quietly hands back a second copy of its state.
 *
 * All warnings. Every one has a shape a page could legitimately have — a
 * `.value` on a plain object, an `emit` from a helper — and the cost of being
 * wrong is a lint the agent learns to ignore.
 */

/** `{{ rows.value }}` / `:rows="rows.value"` — a template unwraps refs itself. */
const TEMPLATE_DOT_VALUE_RE = /\b[A-Za-z_$][\w$]*\.value\b/;

const templateExpressions = (
  source: string,
): { text: string; line: number }[] => {
  const found: { text: string; line: number }[] = [];
  for (const element of templateElements(source)) {
    for (const prop of element.props) {
      if (typeof prop !== "object" || prop === null) continue;
      const exp = Reflect.get(prop, "exp");
      if (typeof exp !== "object" || exp === null) continue;
      const content = Reflect.get(exp, "content");
      if (typeof content === "string") {
        found.push({ text: content, line: element.line });
      }
    }
  }
  return found;
};

/** `{{ … }}` in text, which the element walker does not carry. */
const INTERPOLATION_RE = /\{\{([^}]*)\}\}/g;

const lintTemplateRefs = (path: string, source: string): PageLintFinding[] => {
  const findings: PageLintFinding[] = [];
  for (const { text, line } of templateExpressions(source)) {
    if (!TEMPLATE_DOT_VALUE_RE.test(text)) continue;
    findings.push({
      path,
      line,
      rule: "template-ref-value",
      severity: "warning",
      message: `\`${text.trim().slice(0, 60)}\` — a template unwraps refs itself, so \`.value\` here reads a property that does not exist and renders nothing. Drop \`.value\`.`,
    });
  }
  const lines = source.split("\n");
  const templateStart = lines.findIndex((line) => line.includes("<template"));
  const templateEnd = lines.findIndex((line) => line.includes("</template>"));
  if (templateStart >= 0 && templateEnd > templateStart) {
    for (let index = templateStart; index <= templateEnd; index += 1) {
      const text = lines[index] ?? "";
      for (const match of text.matchAll(INTERPOLATION_RE)) {
        const inner = match[1] ?? "";
        if (!TEMPLATE_DOT_VALUE_RE.test(inner)) continue;
        findings.push({
          path,
          line: index + 1,
          rule: "template-ref-value",
          severity: "warning",
          message: `\`{{${inner.slice(0, 60)}}}\` — a template unwraps refs itself, so \`.value\` renders nothing. Drop \`.value\`.`,
        });
      }
    }
  }
  return findings;
};

/** Hooks and handlers: a composable called in one of these is called too late. */
const LIFECYCLE = new Set([
  "onMounted",
  "onBeforeMount",
  "onUpdated",
  "onUnmounted",
  "onBeforeUnmount",
  "watch",
  "watchEffect",
  "setTimeout",
  "setInterval",
]);

const COMPOSABLE_RE = /^use[A-Z]/;
/** Nuxt UI's own composables are the exception: they are meant to be reachable
 * from a handler, and `useToast()` inside one is the documented shape. */
const RUNTIME_COMPOSABLES = new Set(["useToast", "useOverlay", "useColorMode"]);

export const lintVuePitfalls = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const findings: PageLintFinding[] = path.endsWith(".vue")
    ? lintTemplateRefs(path, source)
    : [];

  const parsed = parsePageScript(path, source);
  if (parsed === null) return findings;
  const { ast, offset } = parsed;
  const at = (node: { [key: string]: unknown; type: string }): number => {
    const line = nodeLine(node);
    return line > 0 ? line + offset : 0;
  };

  let declaresEmits = false;
  const emitCalls: { line: number }[] = [];

  visitAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node["callee"];
    if (!isAstNode(callee)) return;

    if (callee.type === "Identifier") {
      const name = callee["name"];
      if (typeof name !== "string") return;
      if (name === "defineEmits") declaresEmits = true;
      if (name === "emit") emitCalls.push({ line: at(node) });
      // A composable inside a hook or a handler: the state it returns is a
      // fresh, disconnected copy of the one the setup already has.
      if (LIFECYCLE.has(name)) {
        const args = node["arguments"];
        if (!Array.isArray(args)) return;
        for (const arg of args) {
          visitAst(arg, (inner) => {
            if (inner.type !== "CallExpression") return;
            const nested = inner["callee"];
            if (!isAstNode(nested) || nested.type !== "Identifier") return;
            const nestedName = nested["name"];
            if (
              typeof nestedName !== "string" ||
              !COMPOSABLE_RE.test(nestedName) ||
              RUNTIME_COMPOSABLES.has(nestedName)
            ) {
              return;
            }
            findings.push({
              path,
              line: at(inner),
              rule: "composable-scope",
              severity: "warning",
              message: `\`${nestedName}()\` is called inside \`${name}\` — a composable called anywhere but the top level of setup returns a second, disconnected copy of its state. Call it at the top level and use what it returns here.`,
            });
          });
        }
      }
      return;
    }
  });

  if (!declaresEmits && emitCalls.length > 0) {
    findings.push({
      path,
      line: emitCalls[0]?.line ?? 0,
      rule: "missing-define-emits",
      severity: "warning",
      message:
        "`emit(...)` is called but nothing declares it — add `const emit = defineEmits<{ … }>()`. An undeclared emit does nothing and raises nothing.",
    });
  }

  return findings;
};
