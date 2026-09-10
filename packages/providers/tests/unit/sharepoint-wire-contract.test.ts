import { providerManifestSchema } from "@fretik/shared/external-apps/manifest-schema";
import type { ResolvedAction } from "@fretik/shared/external-apps/registry";
import { buildRequest } from "@fretik/shared/services/external-apps/exec/build-request";
import { validateActionArgs } from "@fretik/shared/services/external-apps/exec/validate-args";
import { describe, expect, test } from "bun:test";
import {
  sharepointManifest,
  sharepointMappers,
  sharepointSummaries,
} from "../../src/sharepoint";

/**
 * SharePoint's failure mode is a request that is accepted and answers the
 * WRONG thing, so these pin the wire shape rather than the manifest text.
 * Every assertion runs its args through the same validator + request builder
 * the dispatcher uses.
 *
 * The four ways a Graph call to SharePoint goes quietly wrong:
 *
 *  - **Path addressing.** `/drives/{d}/root:/A/B:/children` is one URL where
 *    the `/` separators are literal and the `:` closes the segment. Encode
 *    the slashes and Graph answers 400; forget the closing colon and it
 *    answers the wrong resource.
 *  - **`search(q='…')`** is an OData function, so the term lives in the PATH.
 *    An unescaped quote or paren ends the call early and the query silently
 *    becomes a different one.
 *  - **List rows** only carry values under `$expand=fields`, keyed by the
 *    column's INTERNAL name, and a filter needs the `fields/` prefix plus a
 *    `Prefer` header past 5 000 rows.
 *  - **The sharing token** is unpadded base64url with a `u!` prefix — plain
 *    base64 resolves to nothing.
 */

const action = (name: string) => {
  const found = sharepointManifest.actions.find((a) => a.name === name);
  if (found === undefined) throw new Error(`no such action: ${name}`);
  return found;
};

const resolve = (name: string): ResolvedAction => {
  const found = action(name);
  const mapperKey = found.request;
  return {
    providerKey: "sharepoint",
    manifest: sharepointManifest,
    transport: sharepointManifest.transport,
    action: found,
    ...(mapperKey !== undefined
      ? { requestMapper: sharepointMappers.request?.[mapperKey] }
      : {}),
  };
};

const send = (name: string, args: Record<string, unknown>) =>
  buildRequest(resolve(name), validateActionArgs(name, action(name), args));

const respond = (
  name: string,
  raw: unknown,
  args: Record<string, unknown> = {},
) => {
  const mapperKey = action(name).response;
  if (mapperKey === undefined)
    throw new Error(`${name} declares no response mapper`);
  const mapper = sharepointMappers.response[mapperKey];
  if (mapper === undefined)
    throw new Error(`missing response mapper ${mapperKey}`);
  return mapper(raw, args);
};

describe("drive item addressing", () => {
  test("a folder path keeps its separators and closes with a colon", () => {
    const built = send("list_folder", {
      drive_id: "b!drive",
      folder_path: "Contracts/2026 Q1",
    });
    expect(built.endpoint).toBe(
      "/v1.0/drives/b!drive/root:/Contracts/2026%20Q1:/children",
    );
  });

  test("an id addresses children without a colon", () => {
    const built = send("list_folder", {
      drive_id: "b!drive",
      folder_id: "01ITEM",
    });
    expect(built.endpoint).toBe("/v1.0/drives/b!drive/items/01ITEM/children");
  });

  test("neither id nor path lands on the library root", () => {
    const built = send("list_folder", { drive_id: "b!drive" });
    expect(built.endpoint).toBe("/v1.0/drives/b!drive/root/children");
  });

  test("get_item by path does NOT carry the trailing colon", () => {
    const built = send("get_item", {
      drive_id: "b!drive",
      item_path: "/Contracts/acme.pdf",
    });
    expect(built.endpoint).toBe(
      "/v1.0/drives/b!drive/root:/Contracts/acme.pdf",
    );
  });

  test("an id wins over a path when both are given", () => {
    const built = send("get_item", {
      drive_id: "b!drive",
      item_id: "01ITEM",
      item_path: "Contracts/acme.pdf",
    });
    expect(built.endpoint).toBe("/v1.0/drives/b!drive/items/01ITEM");
  });

  test("the upload session path interleaves the colons Graph expects", () => {
    const built = send("create_upload_session", {
      drive_id: "b!drive",
      parent_folder_id: "01PARENT",
      file_name: "Q1 report.pdf",
      conflict_behavior: "replace",
    });
    expect(built.endpoint).toBe(
      "/v1.0/drives/b!drive/items/01PARENT:/Q1%20report.pdf:/createUploadSession",
    );
    expect(built.body).toEqual({
      item: { "@microsoft.graph.conflictBehavior": "replace" },
    });
  });
});

describe("library search", () => {
  test("the term rides in the path with quotes doubled and parens escaped", () => {
    const built = send("search_library", {
      drive_id: "b!drive",
      query: "O'Brien (2026)",
    });
    // The doubled quote stays literal — `''` IS the OData escape inside a
    // quoted literal, and `'` is a legal path character. The parens must
    // not be, or they close `search(` early.
    expect(built.endpoint).toBe(
      "/v1.0/drives/b!drive/root/search(q='O''Brien%20%282026%29')",
    );
  });
});

describe("site resolution", () => {
  test("a deep document URL still resolves to its site", () => {
    const built = send("get_site_by_url", {
      site_url:
        "https://contoso.sharepoint.com/sites/Legal/Shared%20Documents/acme.pdf?web=1",
    });
    expect(built.endpoint).toBe(
      "/v1.0/sites/contoso.sharepoint.com:/sites/Legal",
    );
  });

  test("a /teams/ site is a site too", () => {
    const built = send("get_site_by_url", {
      site_url: "https://contoso.sharepoint.com/teams/Sales",
    });
    expect(built.endpoint).toBe(
      "/v1.0/sites/contoso.sharepoint.com:/teams/Sales",
    );
  });

  test("the tenant root has no path, and must not get a dangling colon", () => {
    const built = send("get_site_by_url", {
      site_url: "https://contoso.sharepoint.com",
    });
    expect(built.endpoint).toBe("/v1.0/sites/contoso.sharepoint.com");
  });

  test("a value that is not a URL fails here, not at Graph", () => {
    expect(() =>
      send("get_site_by_url", { site_url: "contoso/Legal" }),
    ).toThrow();
  });
});

describe("sharing links", () => {
  test("a share URL becomes an unpadded base64url token", () => {
    const built = send("resolve_share_link", {
      share_url: "https://contoso.sharepoint.com/:b:/s/Legal/EaBcD?e=xyz",
    });
    expect(built.endpoint.startsWith("/v1.0/shares/u!")).toBe(true);
    const token =
      built.endpoint.slice("/v1.0/shares/".length).split("/")[0] ?? "";
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(built.endpoint.endsWith("/driveItem")).toBe(true);
  });

  test("a calendar-day expiry becomes the end of that day", () => {
    const built = send("create_share_link", {
      drive_id: "b!drive",
      item_id: "01ITEM",
      link_type: "edit",
      scope: "organization",
      expiration_date: "2026-03-31",
    });
    expect(built.body).toEqual({
      type: "edit",
      scope: "organization",
      expirationDateTime: "2026-03-31T23:59:59Z",
    });
  });
});

describe("list rows", () => {
  test("values only come back expanded, and a column subset narrows the expand", () => {
    const plain = send("list_list_items", { site_id: "S", list_id: "L" });
    expect(plain.query?.$expand).toBe("fields");

    const narrowed = send("list_list_items", {
      site_id: "S",
      list_id: "L",
      columns: ["Title", "Status"],
    });
    expect(narrowed.query?.$expand).toBe("fields(select=Title,Status)");
  });

  test("a filter carries the non-indexed opt-in header; an unfiltered read does not", () => {
    const filtered = send("list_list_items", {
      site_id: "S",
      list_id: "L",
      filter: "fields/Status eq 'Open'",
    });
    expect(filtered.query?.$filter).toBe("fields/Status eq 'Open'");
    expect(filtered.headers?.Prefer).toBe(
      "HonorNonIndexedQueriesWarningMayFailRandomly",
    );

    expect(
      send("list_list_items", { site_id: "S", list_id: "L" }).headers,
    ).toBeUndefined();
  });

  test("create wraps the column map, update sends it bare", () => {
    const fields = { Title: "ACME", Amount: 1200 };
    expect(
      send("create_list_item", { site_id: "S", list_id: "L", fields }).body,
    ).toEqual({ fields });
    expect(
      send("update_list_item", {
        site_id: "S",
        list_id: "L",
        item_id: "7",
        fields,
      }).body,
    ).toEqual(fields);
  });

  test("arbitrary column names survive validation — the schema cannot know them", () => {
    const fields = { Statut0: "Ouvert", Due_x0020_date: "2026-04-01" };
    const validated = validateActionArgs(
      "create_list_item",
      action("create_list_item"),
      { site_id: "S", list_id: "L", fields },
    );
    expect(validated.fields).toEqual(fields);
  });

  test("a bare PATCH response is rebuilt into a whole row", () => {
    const mapped = respond(
      "update_list_item",
      { "@odata.etag": '"1"', Title: "ACME", Status: "Open" },
      { item_id: "7" },
    );
    expect(mapped).toEqual({
      id: "7",
      fields: { Title: "ACME", Status: "Open" },
    });
  });
});

describe("response shapes", () => {
  test("the download URL is surfaced so the runtime can spill the bytes", () => {
    const mapped = respond("download_file", {
      id: "01ITEM",
      name: "acme.pdf",
      size: 1234,
      file: { mimeType: "application/pdf" },
      "@microsoft.graph.downloadUrl": "https://contoso.sharepoint.com/dl?x=1",
    }) as Record<string, unknown>;
    expect(mapped.download_url).toBe("https://contoso.sharepoint.com/dl?x=1");
    expect(mapped.content_type).toBe("application/pdf");
  });

  test("a page's cursor is the skiptoken, not the whole nextLink", () => {
    const mapped = respond("list_folder", {
      value: [
        {
          id: "01A",
          name: "a.pdf",
          size: 1,
          webUrl: "https://x/a.pdf",
          createdDateTime: "2026-01-01T00:00:00Z",
          lastModifiedDateTime: "2026-01-02T00:00:00Z",
        },
      ],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/drives/b!d/root/children?$top=100&$skiptoken=ABC123",
    }) as Record<string, unknown>;
    expect(mapped.page_token).toBe("ABC123");
    expect((mapped.items as unknown[]).length).toBe(1);
  });

  test("a last page reports no cursor at all", () => {
    const mapped = respond("list_folder", { value: [] }) as Record<
      string,
      unknown
    >;
    expect("page_token" in mapped).toBe(false);
  });

  test("a column's type is read from which facet exists", () => {
    const mapped = respond("list_columns", {
      value: [
        {
          name: "Statut0",
          displayName: "Statut",
          required: true,
          readOnly: false,
          choice: { choices: ["Open", "Closed"] },
        },
        {
          name: "Modified",
          displayName: "Modified",
          readOnly: true,
          dateTime: {},
        },
      ],
    }) as Record<string, unknown>[];
    expect(mapped[0]?.type).toBe("choice");
    expect(mapped[0]?.choices).toEqual(["Open", "Closed"]);
    expect(mapped[1]?.type).toBe("dateTime");
    expect(mapped[1]?.read_only).toBe(true);
  });

  test("search hits are dug out of value[].hitsContainers[].hits[]", () => {
    const mapped = respond("search", {
      value: [
        {
          hitsContainers: [
            {
              hits: [
                {
                  summary: "…<c0>renewal</c0>…",
                  resource: {
                    "@odata.type": "#microsoft.graph.driveItem",
                    id: "01A",
                    name: "acme.pdf",
                    size: 42,
                    webUrl: "https://x/acme.pdf",
                    parentReference: { driveId: "b!drive" },
                  },
                },
              ],
            },
          ],
        },
      ],
    }) as Record<string, unknown>[];
    expect(mapped.length).toBe(1);
    expect(mapped[0]?.kind).toBe("driveItem");
    expect(mapped[0]?.drive_id).toBe("b!drive");
    expect(mapped[0]?.name).toBe("acme.pdf");
  });

  test("a list row hit takes its name from fields.Title", () => {
    const mapped = respond("search", {
      value: [
        {
          hitsContainers: [
            {
              hits: [
                {
                  summary: "…",
                  resource: {
                    "@odata.type": "#microsoft.graph.listItem",
                    id: "7",
                    fields: { Title: "ACME renewal" },
                    parentReference: { siteId: "S", listId: "L" },
                  },
                },
              ],
            },
          ],
        },
      ],
    }) as Record<string, unknown>[];
    expect(mapped[0]?.kind).toBe("listItem");
    expect(mapped[0]?.name).toBe("ACME renewal");
    expect(mapped[0]?.site_id).toBe("S");
  });

  test("a page's prose is concatenated from its text web parts, in order", () => {
    const mapped = respond("get_page", {
      id: "P1",
      name: "Home.aspx",
      title: "Home",
      webUrl: "https://x/Home.aspx",
      publishingState: { level: "published" },
      lastModifiedDateTime: "2026-02-01T00:00:00Z",
      canvasLayout: {
        horizontalSections: [
          {
            columns: [
              { webparts: [{ innerHtml: "<p>first</p>" }, { imageUrl: "…" }] },
              { webparts: [{ innerHtml: "<p>second</p>" }] },
            ],
          },
        ],
        verticalSection: { webparts: [{ innerHtml: "<p>aside</p>" }] },
      },
    }) as Record<string, unknown>;
    expect(mapped.content_html).toBe(
      "<p>first</p>\n<p>second</p>\n<p>aside</p>",
    );
    expect(mapped.published_at).toBe("2026-02-01T00:00:00Z");
  });

  test("an inherited permission is flagged so the agent stops before failing", () => {
    const mapped = respond("list_permissions", {
      value: [
        {
          id: "perm1",
          roles: ["read"],
          inheritedFrom: { driveId: "b!d", id: "01ROOT" },
          grantedToV2: { user: { displayName: "Marie Dupont" } },
        },
        {
          id: "perm2",
          roles: ["write"],
          link: {
            type: "edit",
            scope: "organization",
            webUrl: "https://x/share",
          },
        },
      ],
    }) as Record<string, unknown>[];
    expect(mapped[0]?.inherited).toBe(true);
    expect(mapped[0]?.granted_to).toEqual(["Marie Dupont"]);
    expect(mapped[1]?.inherited).toBe(false);
    expect(mapped[1]?.link_scope).toBe("organization");
  });
});

describe("brand mark", () => {
  test("the glyph is the Iconify name, with the Fluent ramp and a flat fallback", () => {
    expect(sharepointManifest.icon).toBe("i-simple-icons-microsoftsharepoint");
    // Microsoft publishes the SharePoint logo as this ramp; the flat colour
    // is its first stop, so a renderer that ignores gradients still shows a
    // correctly-branded mark rather than falling back to `primary`.
    expect(sharepointManifest.iconGradient).toEqual([
      "#036C70",
      "#1A9BA1",
      "#37C6D0",
    ]);
    expect(sharepointManifest.iconColor).toBe("#036C70");
  });

  test("a ramp without a flat fallback is refused at registry load", () => {
    const { iconColor: _dropped, ...withoutFlat } = sharepointManifest;
    expect(() => providerManifestSchema.parse(withoutFlat)).toThrow();
    // …and the manifest as shipped still parses.
    expect(() =>
      providerManifestSchema.parse(sharepointManifest),
    ).not.toThrow();
  });
});

describe("approval cards", () => {
  test("every write action has a summary and none of them leaks a Graph id", () => {
    const writes = sharepointManifest.actions.filter((a) => a.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
    const idLabels = new Set([
      "drive_id",
      "item_id",
      "site_id",
      "list_id",
      "permission_id",
      "parent_folder_id",
      "target_folder_id",
      "target_drive_id",
      "new_parent_folder_id",
    ]);
    for (const write of writes) {
      const summary = sharepointSummaries[write.name];
      expect(summary).toBeDefined();
      const card = summary?.({
        drive_id: "b!drive",
        item_id: "01ITEM",
        site_id: "S",
        list_id: "L",
        permission_id: "perm1",
        parent_folder_id: "01PARENT",
        target_folder_id: "01DEST",
        new_parent_folder_id: "01DEST",
        version_id: "3.0",
        name: "Contracts",
        file_name: "acme.pdf",
        emails: ["marie@example.com"],
        fields: { Title: "ACME" },
      });
      for (const f of card?.fields ?? []) {
        expect(idLabels.has(f.labelKey)).toBe(false);
      }
    }
  });
});
