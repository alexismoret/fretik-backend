import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { badRequest, throwHttpError } from "@fretik/shared/lib/errors";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { readLinkPreview } from "../lib/web";

/**
 * The cover image of a page a `:::link-card` points at, read on demand.
 *
 * Lives in @fretik/ai rather than @fretik/api because the read, its egress
 * guard and its cache are `lib/web/` — the module that already performs exactly
 * this request for every search hit, and the only place in the codebase allowed
 * to fetch the open web from this process.
 *
 * It answers the half of the problem a transcript cannot: a card's cover is
 * joined to a search hit by URL, so a card whose page NO search returned has no
 * hit to join to. The model writes such cards routinely — naming a site it
 * knows rather than one it just read — and until this route existed those were
 * favicon tiles for good, however plainly the page published a picture.
 */

const querySchema = z.object({
  url: z.string().trim().min(1).max(2_048),
});

const linkPreviewRoutes = new OpenAPIHono<HonoLoggedAppType>();
linkPreviewRoutes.use("*", authMiddleware);

/**
 * GET /link-preview?url=… — `{ image, siteName, cached }`.
 *
 * **200 with a null image is the normal failure.** Roughly one page in three
 * publishes no cover, some origins refuse a bot outright, and the card renders
 * a favicon band for both — so a preview that found nothing is an answer, not
 * an error, and reporting it as a 4xx/5xx would put a red console line under
 * every such card. The only 400 is a URL that is not one.
 */
linkPreviewRoutes.get("/", async (c) => {
  const parsed = querySchema.safeParse({ url: c.req.query("url") });
  if (!parsed.success) {
    return throwHttpError(
      400,
      badRequest("A `url` query parameter is required"),
    );
  }

  // Parsed here rather than left to the egress guard so a typo answers 400
  // instead of spending a DNS resolution to answer 200-with-nothing. The guard
  // still runs inside the read — it is the one that matters, and it re-checks
  // every redirect hop this one cannot see.
  let target: URL;
  try {
    target = new URL(parsed.data.url);
  } catch {
    return throwHttpError(400, badRequest("`url` is not a valid URL"));
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return throwHttpError(400, badRequest("`url` must be http(s)"));
  }

  const preview = await readLinkPreview(target.toString());
  return c.json(preview, 200);
});

export { linkPreviewRoutes };
