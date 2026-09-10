import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";
import type { ProviderMappers } from "@fretik/shared/external-apps/provider-types";
import type { ResolvedAction } from "@fretik/shared/external-apps/registry";
import { buildRequest } from "@fretik/shared/services/external-apps/exec/build-request";
import { validateActionArgs } from "@fretik/shared/services/external-apps/exec/validate-args";
import { describe, expect, test } from "bun:test";
import { plannerManifest, plannerMappers } from "../../src/planner";
import { teamsManifest, teamsMappers, teamsSummaries } from "../../src/teams";

/**
 * The seams between the Microsoft apps, where a call is accepted and does
 * the wrong thing:
 *
 *  - A Teams attachment is TWO coupled pieces — the `attachments[]` entry and
 *    an `<attachment id="…">` tag carrying the same GUID. Graph accepts a
 *    message with only one of them and silently renders it without the file.
 *  - A channel's Files folder answers a driveItem whose `driveId` lives on
 *    `parentReference`, not on the item. Reading `id` twice yields a folder
 *    id used as a drive id, and every later call 404s.
 *  - A Planner reference is keyed BY ITS URL, and OData bans `.` `:` `%` `@`
 *    `#` in an open-type key. An unencoded key is accepted and the reference
 *    never appears on the task.
 */

const resolveFrom = (
  manifest: ProviderManifest,
  mappers: ProviderMappers,
  providerKey: string,
) => {
  const action = (name: string) => {
    const found = manifest.actions.find((a) => a.name === name);
    if (found === undefined) throw new Error(`no such action: ${name}`);
    return found;
  };
  const send = (name: string, args: Record<string, unknown>) => {
    const found = action(name);
    const mapperKey = found.request;
    const resolved: ResolvedAction = {
      providerKey,
      manifest,
      transport: manifest.transport,
      action: found,
      ...(mapperKey !== undefined
        ? { requestMapper: mappers.request[mapperKey] }
        : {}),
    };
    return buildRequest(resolved, validateActionArgs(name, found, args));
  };
  const respond = (name: string, raw: unknown) => {
    const mapperKey = action(name).response;
    if (mapperKey === undefined) {
      throw new Error(`${name} declares no response mapper`);
    }
    const mapper = mappers.response[mapperKey];
    if (mapper === undefined) throw new Error(`missing mapper ${mapperKey}`);
    return mapper(raw);
  };
  return { action, send, respond };
};

const teams = resolveFrom(teamsManifest, teamsMappers, "teams");
const planner = resolveFrom(plannerManifest, plannerMappers, "planner");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("Teams attachments by reference", () => {
  const send = (name: string, extra: Record<string, unknown>) =>
    teams.send(name, {
      body_html: "<p>Voici le rapport.</p>",
      attachments: [
        {
          name: "Q1-report.pdf",
          content_url:
            "https://contoso.sharepoint.com/sites/Legal/Shared%20Documents/Q1-report.pdf",
        },
      ],
      ...extra,
    });

  test("the entry and the body tag carry the SAME generated id", () => {
    const built = send("send_channel_message", {
      team_id: "T1",
      channel_id: "19:abc@thread.tacv2",
    });
    const body = built.body as Record<string, unknown>;
    const attachments = body.attachments as Record<string, unknown>[];
    expect(attachments.length).toBe(1);

    const id = attachments[0]?.id as string;
    expect(id).toMatch(UUID_RE);
    expect(attachments[0]?.contentType).toBe("reference");
    expect(attachments[0]?.name).toBe("Q1-report.pdf");

    const html = (body.body as Record<string, unknown>).content as string;
    expect(html).toContain(`<attachment id="${id}"></attachment>`);
    // The prose the agent wrote survives — the tag is appended, not swapped in.
    expect(html.startsWith("<p>Voici le rapport.</p>")).toBe(true);
  });

  test("all three send actions accept them", () => {
    for (const [name, extra] of [
      ["send_chat_message", { chat_id: "19:x" }],
      ["send_channel_message", { team_id: "T1", channel_id: "19:c" }],
      [
        "reply_to_channel_message",
        { team_id: "T1", channel_id: "19:c", message_id: "170" },
      ],
    ] as const) {
      const body = send(name, extra).body as Record<string, unknown>;
      expect((body.attachments as unknown[]).length).toBe(1);
    }
  });

  test("no attachments means no key at all — not an empty array", () => {
    const built = teams.send("send_chat_message", {
      chat_id: "19:x",
      body_html: "<p>Hello.</p>",
    });
    const body = built.body as Record<string, unknown>;
    expect("attachments" in body).toBe(false);
  });

  test("an entry with no content_url is dropped, tag included", () => {
    const built = teams.send("send_chat_message", {
      chat_id: "19:x",
      body_html: "<p>Hello.</p>",
      attachments: [{ name: "ghost.pdf", content_url: "" }],
    });
    const body = built.body as Record<string, unknown>;
    expect("attachments" in body).toBe(false);
    expect((body.body as Record<string, unknown>).content).toBe(
      "<p>Hello.</p>",
    );
  });

  test("inline images and attachments coexist, each with its own tag", () => {
    const built = teams.send("send_chat_message", {
      chat_id: "19:x",
      body_html: "<p>Deux choses.</p>",
      inline_images: [
        {
          name: "chart.png",
          content_type: "image/png",
          content_base64: "aGk=",
        },
      ],
      attachments: [
        { name: "report.pdf", content_url: "https://contoso.sharepoint.com/a" },
      ],
    });
    const body = built.body as Record<string, unknown>;
    const html = (body.body as Record<string, unknown>).content as string;
    expect((body.hostedContents as unknown[]).length).toBe(1);
    expect((body.attachments as unknown[]).length).toBe(1);
    expect(html).toContain("<img src=");
    expect(html).toContain("<attachment id=");
  });

  test("the approval card names the file, and never its URL", () => {
    const card = teamsSummaries.send_channel_message?.({
      team_id: "T1",
      channel_id: "19:c",
      body_html: "<p>Voici.</p>",
      attachments: [
        {
          name: "Q1-report.pdf",
          content_url: "https://contoso.sharepoint.com/x",
        },
      ],
    });
    const row = card?.fields.find((f) => f.labelKey === "attachments");
    expect(row?.value).toBe("Q1-report.pdf");
    for (const f of card?.fields ?? []) {
      expect(f.value).not.toContain("sharepoint.com");
    }
  });
});

describe("channel Files folder → sharepoint ids", () => {
  test("drive_id comes from parentReference, folder_id from the item", () => {
    const mapped = teams.respond("get_channel_files_folder", {
      id: "01H7CFEKENJSSIUHGADZBKODARINQC5JMD",
      name: "Documentation Planning",
      webUrl: "https://contoso.sharepoint.com/teams/Eng/Shared%20Documents/Doc",
      parentReference: { driveId: "b!2SInBlQrN0K8-GXMy9qNsPtI5ScW" },
    }) as Record<string, unknown>;
    expect(mapped.drive_id).toBe("b!2SInBlQrN0K8-GXMy9qNsPtI5ScW");
    expect(mapped.folder_id).toBe("01H7CFEKENJSSIUHGADZBKODARINQC5JMD");
    expect(mapped.drive_id).not.toBe(mapped.folder_id);
  });

  test("it is a read — no approval stands between a channel and its folder", () => {
    expect(teams.action("get_channel_files_folder").kind).toBe("read");
  });
});

describe("Planner references", () => {
  const body = (references: unknown) =>
    planner.send("update_task_details", {
      task_id: "T",
      etag: 'W/"x"',
      references,
    }).body as Record<string, unknown>;

  test("the URL becomes the key, with every OData-banned char encoded", () => {
    const refs = body([
      {
        url: "https://contoso.sharepoint.com/sites/Legal/acme.docx",
        alias: "MSA ACME",
      },
    ]).references as Record<string, Record<string, unknown>>;

    const key = Object.keys(refs)[0] ?? "";
    expect(key).toBe(
      "https%3A//contoso%2Esharepoint%2Ecom/sites/Legal/acme%2Edocx",
    );
    for (const banned of [".", ":", "@", "#"]) {
      expect(key.includes(banned)).toBe(false);
    }
    expect(refs[key]?.alias).toBe("MSA ACME");
    expect(refs[key]?.["@odata.type"]).toBe(
      "#microsoft.graph.plannerExternalReference",
    );
  });

  test("a literal % is escaped before the rest, not after", () => {
    const refs = body([
      { url: "https://contoso.sharepoint.com/Shared%20Documents/a.pdf" },
    ]).references as Record<string, unknown>;
    const key = Object.keys(refs)[0] ?? "";
    // `%20` → `%2520`, never `%20` left raw or double-encoded twice over.
    expect(key).toContain("Shared%2520Documents");
  });

  test("the type drives Planner's preview, from the extension", () => {
    const typeOf = (url: string) => {
      const refs = body([{ url }]);
      const entry = Object.values(
        refs.references as Record<string, Record<string, unknown>>,
      )[0];
      return entry?.type;
    };
    expect(typeOf("https://x.com/a.docx")).toBe("Word");
    expect(typeOf("https://x.com/a.xlsx")).toBe("Excel");
    expect(typeOf("https://x.com/a.pptx")).toBe("PowerPoint");
    expect(typeOf("https://x.com/a.pdf")).toBe("Other");
    // A query string must not be mistaken for the extension.
    expect(typeOf("https://x.com/a.docx?web=1")).toBe("Word");
  });

  test("the alias falls back to the URL, so no reference is unlabelled", () => {
    const refs = body([{ url: "https://x.com/a.pdf" }]);
    const entry = Object.values(
      refs.references as Record<string, Record<string, unknown>>,
    )[0];
    expect(entry?.alias).toBe("https://x.com/a.pdf");
  });

  test("omitting references leaves the existing set untouched", () => {
    const built = planner.send("update_task_details", {
      task_id: "T",
      etag: 'W/"x"',
      description: "just the text",
    }).body as Record<string, unknown>;
    expect("references" in built).toBe(false);
  });
});
