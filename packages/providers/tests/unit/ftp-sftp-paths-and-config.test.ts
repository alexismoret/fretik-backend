import { describe, expect, test } from "bun:test";
import { parseFileTransferConfig } from "../../src/ftp-sftp/config";
import { freeNameIn } from "../../src/ftp-sftp/handlers";
import {
  matchesPattern,
  normalizePath,
  PathOutsideRootError,
  resolveRemotePath,
  toDisplayPath,
} from "../../src/ftp-sftp/paths";
import { ftpSftpSummaries } from "../../src/ftp-sftp/summaries";

/**
 * The three pieces of this provider a live smoke test cannot reach.
 *
 * `paths.ts` decides where every byte is read from and written to — a
 * root-relative path that escapes its root writes a partner's file into the
 * wrong customer's folder, and no protocol error is raised when it happens.
 *
 * `config.ts` reads values that Nango stores as STRINGS, so the port and the
 * self-signed toggle are exactly the fields a naive read turns back into
 * their defaults — silently, on a connection that then fails with a message
 * about something else.
 *
 * `summaries.ts` writes the approval card. The recursive-delete card is the
 * only place a user is told that the operation they are approving has no
 * undo.
 */

describe("normalizePath", () => {
  test("collapses . and .. and duplicate separators", () => {
    expect(normalizePath("/edi//in/./orders")).toBe("/edi/in/orders");
    expect(normalizePath("/edi/in/../out")).toBe("/edi/out");
    expect(normalizePath("in/./a//b")).toBe("in/a/b");
  });

  test("keeps a leading .. on a relative path so confinement can see it", () => {
    expect(normalizePath("../secrets")).toBe("../secrets");
  });

  test("cannot climb above an absolute root", () => {
    expect(normalizePath("/../../etc")).toBe("/etc");
  });
});

describe("resolveRemotePath", () => {
  test("passes paths through when the connection is not pinned", () => {
    expect(resolveRemotePath("", "in/orders.csv")).toBe("in/orders.csv");
    expect(resolveRemotePath("", "/abs/orders.csv")).toBe("/abs/orders.csv");
  });

  test("an empty path asks the server for its own working directory", () => {
    expect(resolveRemotePath("", "")).toBe(".");
  });

  test("resolves against the pinned root", () => {
    expect(resolveRemotePath("/edi/in", "orders.csv")).toBe(
      "/edi/in/orders.csv",
    );
    expect(resolveRemotePath("edi/in", "orders.csv")).toBe(
      "/edi/in/orders.csv",
    );
  });

  test("treats an absolute path from the agent as root-relative", () => {
    // The agent is SHOWN "/orders.csv" by toDisplayPath, so sending it back
    // has to land where it was read from — not at the server's real root.
    expect(resolveRemotePath("/edi/in", "/orders.csv")).toBe(
      "/edi/in/orders.csv",
    );
  });

  test("refuses a path that climbs out of the root", () => {
    expect(() => resolveRemotePath("/edi/in", "../out/secret.csv")).toThrow(
      PathOutsideRootError,
    );
    expect(() => resolveRemotePath("/edi/in", "a/../../../etc/passwd")).toThrow(
      PathOutsideRootError,
    );
  });

  test("the root itself is inside the root", () => {
    expect(resolveRemotePath("/edi/in", "")).toBe("/edi/in");
    expect(resolveRemotePath("/edi/in", "/")).toBe("/edi/in");
  });

  test("a sibling directory sharing the root's prefix is outside it", () => {
    // `/edi/inbox` starts with `/edi/in` as a STRING but is a different
    // folder — the check has to be on the segment boundary.
    expect(() => resolveRemotePath("/edi/in", "../inbox/x.csv")).toThrow(
      PathOutsideRootError,
    );
  });
});

describe("toDisplayPath", () => {
  test("hides the pinned root from what the agent reads back", () => {
    expect(toDisplayPath("/edi/in", "/edi/in/orders.csv")).toBe("/orders.csv");
    expect(toDisplayPath("/edi/in", "/edi/in")).toBe("/");
  });

  test("leaves an unpinned connection's paths alone", () => {
    expect(toDisplayPath("", "/edi/in/orders.csv")).toBe("/edi/in/orders.csv");
  });

  test("round-trips with resolveRemotePath", () => {
    const shown = toDisplayPath("/edi/in", "/edi/in/sub/orders.csv");
    expect(resolveRemotePath("/edi/in", shown)).toBe("/edi/in/sub/orders.csv");
  });
});

describe("matchesPattern", () => {
  test("matches globs case-insensitively", () => {
    // Half the servers in this space are Windows, where ORDER.CSV and
    // order.csv are one file.
    expect(matchesPattern("ORDER_01.CSV", "*.csv")).toBe(true);
    expect(matchesPattern("order_01.csv", "ORDER_??.csv")).toBe(true);
    expect(matchesPattern("order_1.csv", "ORDER_??.csv")).toBe(false);
  });

  test("an empty pattern matches everything", () => {
    expect(matchesPattern("anything.bin", "")).toBe(true);
  });
});

describe("parseFileTransferConfig", () => {
  const credentials = { username: "edi", password: "s3cret" };

  test("reads a port Nango stored as a string", () => {
    const config = parseFileTransferConfig(credentials, {
      protocol: "sftp",
      host: "files.example.com",
      port: "2222",
    });
    expect(config.port).toBe(2222);
  });

  test("falls back to the protocol's standard port when none was given", () => {
    const at = (protocol: string) =>
      parseFileTransferConfig(credentials, {
        protocol,
        host: "files.example.com",
        port: "",
      }).port;
    expect(at("sftp")).toBe(22);
    expect(at("ftp")).toBe(21);
    expect(at("ftps")).toBe(21);
    expect(at("ftps-implicit")).toBe(990);
  });

  test("reads a boolean Nango stored as a string", () => {
    const config = parseFileTransferConfig(credentials, {
      protocol: "ftps",
      host: "files.example.com",
      allow_self_signed_cert: "true",
    });
    expect(config.allowSelfSignedCert).toBe(true);
  });

  test("sends only the secret the chosen auth method needs", () => {
    const keyed = parseFileTransferConfig(
      {
        username: "edi",
        password: "left-over-from-an-earlier-attempt",
        private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
        passphrase: "pp",
      },
      {
        protocol: "sftp",
        host: "files.example.com",
        auth_method: "private_key",
      },
    );
    // Handing ssh2 both makes it pick, and the failure then names the
    // wrong credential.
    expect(keyed.password).toBeUndefined();
    expect(keyed.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(keyed.passphrase).toBe("pp");
  });

  test("refuses key auth on a protocol that has no such thing", () => {
    expect(() =>
      parseFileTransferConfig(
        { username: "edi", private_key: "key" },
        { protocol: "ftps", host: "h", auth_method: "private_key" },
      ),
    ).toThrow(/SSH key authentication exists on SFTP/);
  });

  test("names the missing secret rather than failing at the server", () => {
    expect(() =>
      parseFileTransferConfig(
        { username: "edi" },
        { protocol: "sftp", host: "h", auth_method: "password" },
      ),
    ).toThrow(/password/);
    expect(() =>
      parseFileTransferConfig(
        { username: "edi" },
        { protocol: "sftp", host: "h", auth_method: "private_key" },
      ),
    ).toThrow(/private key/);
  });
});

describe("approval summaries", () => {
  test("a recursive folder delete says so in the title", () => {
    const summary = ftpSftpSummaries.delete_directory;
    expect(summary).toBeDefined();
    expect(summary!({ path: "/edi/archive", recursive: true }).titleKey).toBe(
      "recursive",
    );
    expect(summary!({ path: "/edi/archive", recursive: false }).titleKey).toBe(
      "default",
    );
  });

  test("an upload card shows paths and the overwrite policy, never bytes", () => {
    const part = ftpSftpSummaries.upload_files!({
      files: [
        { remote_path: "out/a.csv", content_base64: "YQ==" },
        { remote_path: "out/b.csv", content_base64: "Yg==" },
      ],
      on_conflict: "replace",
    });
    const rendered = part.fields.map((f) => f.value).join("\n");
    expect(rendered).toContain("out/a.csv");
    expect(rendered).toContain("out/b.csv");
    expect(rendered).toContain("replace");
    expect(rendered).not.toContain("YQ==");
    expect(part.titleKey).toBe("default");
    expect(part.titleParams?.count).toBe("2");
  });

  test("every write action has a summary builder", () => {
    // The registry refuses a manifest whose write actions are not all
    // covered — pinned here so the failure names the action.
    const { ftpSftpManifest } = require("../../src/ftp-sftp/manifest") as {
      ftpSftpManifest: { actions: { name: string; kind: string }[] };
    };
    const writes = ftpSftpManifest.actions
      .filter((a) => a.kind === "write")
      .map((a) => a.name);
    expect(writes.sort()).toEqual(Object.keys(ftpSftpSummaries).sort());
  });
});

describe("upload conflict — the rename ladder", () => {
  test("keeps the extension and counts up", () => {
    expect(freeNameIn(new Set(["report.csv"]), "report.csv")).toBe(
      "report (1).csv",
    );
    expect(
      freeNameIn(new Set(["report.csv", "report (1).csv"]), "report.csv"),
    ).toBe("report (2).csv");
  });

  test("handles a name with no extension", () => {
    expect(freeNameIn(new Set(["README"]), "README")).toBe("README (1)");
  });

  test("gives up rather than returning a taken name", () => {
    // `rename` exists so a partner\u2019s file is never overwritten. Handing
    // back an occupied name would do exactly what the policy forbids, so a
    // crowded folder has to answer null and let the caller report it.
    const taken = new Set(["a.txt"]);
    for (let i = 1; i <= 20; i += 1) taken.add(`a (${i.toString()}).txt`);
    expect(freeNameIn(taken, "a.txt")).toBeNull();
  });

  test("a dotfile keeps its leading dot", () => {
    // `.env` has no stem before the dot \u2014 suffixing on the last dot would
    // produce " (1).env" and lose the file\u2019s identity.
    expect(freeNameIn(new Set([".env"]), ".env")).toBe(".env (1)");
  });
});
