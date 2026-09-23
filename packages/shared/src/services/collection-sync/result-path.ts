/**
 * Walk a plain dot path (`value.items[0].rows`) into an upstream answer.
 * Property and index steps only — a path is DATA, nothing evaluates. Returns
 * undefined the moment a step finds nothing.
 *
 * Lifted verbatim out of `exec/page-query.ts`, which still imports it: the page
 * dataset and a sync source both let a person name where the rows live inside
 * an answer, and two implementations of that would be two grammars a user could
 * tell apart. The direction of the import looks backwards (an `external-apps`
 * executor reading from `collection-sync`) and is deliberate — this module has
 * no imports of its own, so it can sit anywhere without closing a cycle, and it
 * belongs next to the walker that has the most to say about paths.
 */
export const resolveResultPath = (payload: unknown, path: string): unknown => {
  let current: unknown = payload;
  for (const match of path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== "object") return undefined;
    const property = match[1];
    if (property !== undefined) {
      current = Reflect.get(current, property);
    } else if (match[2] !== undefined) {
      current = Array.isArray(current) ? current[Number(match[2])] : undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
};
