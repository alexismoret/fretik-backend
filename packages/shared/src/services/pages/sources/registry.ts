import type { PageDatasetKind } from "../../../schemas/pages";
import { externalSource } from "./external";
import { inlineSource } from "./inline";
import { objectsSource } from "./objects";
import { transformSource } from "./transform";
import type { PageDataSource } from "./types";

/**
 * Every place a page's rows can come from, by kind.
 *
 * The executor never branches on the kind — it looks the source up here. A new
 * source is one file plus one line, and nothing about ordering, degradation or
 * the security boundary has to be touched.
 */
const SOURCES: PageDataSource[] = [
  inlineSource,
  objectsSource,
  transformSource,
  externalSource,
];

const BY_KIND = new Map<PageDatasetKind, PageDataSource>(
  SOURCES.map((source) => [source.kind, source]),
);

export const pageDataSource = (
  kind: PageDatasetKind,
): PageDataSource | undefined => BY_KIND.get(kind);
