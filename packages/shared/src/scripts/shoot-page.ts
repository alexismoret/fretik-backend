/**
 * Render a stored page and write the frames to disk — the same six the design
 * critic is shown, plus what the click-pass found.
 *
 * Looking at a generated page in the browser answers "does it work"; this
 * answers "what was it judged on". They are different questions and both are
 * needed: the browser shows one viewport of a live page, while the critic sees
 * a full-height desktop capture, its bottom, tablet, mobile, whatever an
 * overlay-opening click revealed, and the empty state. A design finding that
 * only exists at 390px, or below the fold, is invisible in the first and
 * obvious in the second.
 *
 *   cd backend/packages/shared
 *   bun --env-file=../../.env --env-file=../api/.env \
 *     run src/scripts/shoot-page.ts <pageId> [outDir]
 *
 * Two env files because the renderer's harness needs Redis and the page needs
 * the database. Needs a browser (see `render/webview.ts`); without one it says
 * so and writes nothing rather than pretending.
 */

import db from "../db";
import { renderPage } from "../services/pages/render/render-page";
import { closeRenderViews } from "../services/pages/render/webview";

const pageId = process.argv[2] ?? "";
const outDir = process.argv[3] ?? ".";

const row = await db.query.pages.findFirst({ where: { id: pageId } });
if (!row) {
  console.error(`no page ${pageId}`);
  process.exit(1);
}
const compiled = row.definition.code.compiled;
if (!compiled) {
  console.error(`page ${pageId} has no compiled artifact`);
  process.exit(1);
}

const result = await renderPage({
  compiled,
  definition: row.definition,
  teamId: row.teamId,
  userId: null,
  pageName: row.name,
});

if (result.degraded !== undefined) {
  console.error(`degraded: ${result.degraded}`);
  closeRenderViews();
  process.exit(1);
}

console.log(`${row.name} — mounted=${String(result.mounted)}`);
for (const shot of result.shots) {
  const file = `${outDir}/${pageId.slice(0, 8)}-${shot.label.replaceAll(/[^a-z0-9]/gi, "_")}.png`;
  await Bun.write(file, shot.png);
  console.log(
    `  ${file}  ${shot.width.toString()}x${shot.height.toString()}${shot.caption !== undefined ? `  ${shot.caption}` : ""}`,
  );
}

// What a picture cannot say: whether the things that look clickable did
// anything. `domChanged=false` on a row is the defect that photographs fine.
console.log("interactions:");
for (const step of result.interactions) {
  console.log(
    `  [${step.kind}] ${step.target} — changed=${String(step.domChanged)} overlay=${String(step.overlayOpened)} overlayText=${step.overlayTextLength.toString()}`,
  );
}
if (result.pageErrors.length > 0) console.log("pageErrors:", result.pageErrors);
const unresolved = result.unresolvedComponents ?? [];
if (unresolved.length > 0) console.log("unresolved components:", unresolved);

closeRenderViews();
process.exit(0);
