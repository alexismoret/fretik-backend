import { join } from "node:path";
import { BUNDLED_SKILLS_DIR } from "../../skills/paths";

/**
 * The design doctrine, handed to the page builder instead of being fetched.
 *
 * The builder's own prompt used to order it to READ `design.md` before writing
 * the brief, and `taste.md` when the brief felt generic. Both instructions were
 * right about the content and wrong about the delivery: this agent designs a
 * page on every single run, so a file it must always read is not a reference —
 * it is part of its prompt that happens to cost a tool step and ~4 500 fresh
 * tokens to assemble. Appended here it costs a cached prefix instead.
 *
 * ONE source, two consumers, exactly like the environment contract: the files
 * stay the skill's own, still read by the main agent when IT edits a page. A
 * copy authored into the prompt would drift the week either file improved.
 *
 * What deliberately stays a read: `components.md` and `data.md` (conditional —
 * a page with no records needs neither) and the pattern files (one family per
 * page at most). Only doctrine that fires on EVERY page earns prompt space.
 */

const reference = (name: string): Promise<string> =>
  Bun.file(
    join(BUNDLED_SKILLS_DIR, "building-pages", "references", name),
  ).text();

/**
 * Read once at module load. The prompt is assembled per turn but its content is
 * constant, which is the whole point — a prefix that varies is a prefix that
 * never hits the cache.
 */
const DESIGN = await reference("design.md");
const TASTE = await reference("taste.md");

export const renderPageDesignDoctrine = (): string =>
  `${DESIGN.trim()}\n\n---\n\n${TASTE.trim()}`;
