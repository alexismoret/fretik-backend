import { describe, expect, it } from "bun:test";
import { buildFormData } from "../../src/services/external-apps/exec/http-direct";

/**
 * How a binary is framed on the wire.
 *
 * `http-direct` used to stamp `Content-Type: application/json` on every
 * body it had, which made a file upload impossible: Directus stores bytes
 * from a multipart part and from no other shape, so Pbyp could read a
 * customer's document management but never write to it.
 *
 * Everything asserted here fails silently if it regresses. A file part
 * whose bytes were re-encoded still uploads and still answers 2xx — the
 * document is simply corrupt when someone opens it months later. A text
 * part sent after the file is parsed too late to reach the row. Neither
 * shows up as an error anywhere.
 */

const PDF = "%PDF-1.4\n%âãÏÓ\n";

const multipart = {
  fields: { title: "BL-CMA-2026-001.pdf", folder: "ged" },
  file: {
    field: "file",
    filename: "BL-CMA-2026-001.pdf",
    contentType: "application/pdf",
    base64: Buffer.from(PDF, "binary").toString("base64"),
  },
};

describe("buildFormData", () => {
  it("puts every text part before the file", () => {
    // Busboy-based servers apply the fields parsed BEFORE the binary to
    // the row they create; one sent after it arrives too late.
    const keys = [...buildFormData(multipart).keys()];
    expect(keys).toEqual(["title", "folder", "file"]);
  });

  it("sends the bytes unchanged, under the declared name and type", async () => {
    const form = buildFormData(multipart);
    const part = form.get("file");
    if (!(part instanceof Blob)) throw new Error("file part is not a blob");
    expect(part.type).toBe("application/pdf");
    expect(form.get("title")).toBe("BL-CMA-2026-001.pdf");

    const bytes = new Uint8Array(await part.arrayBuffer());
    expect([...bytes]).toEqual([...Buffer.from(PDF, "binary")]);
  });

  it("survives a round trip through an actual request body", async () => {
    // The boundary is `fetch`'s to write; the point of the assertion is
    // that it never has to be set by hand, which is what would leave the
    // header without one and the server unable to parse a body it can see.
    const request = new Request("https://example.test/files", {
      method: "POST",
      body: buildFormData(multipart),
    });
    expect(request.headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    );
    const parsed = await request.formData();
    const part = parsed.get("file");
    if (!(part instanceof File)) throw new Error("file part did not survive");
    expect(part.name).toBe("BL-CMA-2026-001.pdf");
    // Byte-for-byte, not text: a PDF is not UTF-8 and decoding one would
    // compare two different corruptions rather than the bytes sent.
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([
      ...Buffer.from(PDF, "binary"),
    ]);
  });

  it("accepts a body with no text parts at all", () => {
    const form = buildFormData({ file: multipart.file });
    expect([...form.keys()]).toEqual(["file"]);
  });
});
