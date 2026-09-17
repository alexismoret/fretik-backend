import { describe, expect, test } from "bun:test";
import { explainBlockedEgress } from "../../src/services/e2b/egress-hint";

/**
 * Translating a killed TLS handshake into a policy refusal.
 *
 * Every `errorText` below is verbatim from a real sandbox
 * (`scripts/smoke-sandbox-egress.ts` against the live template), not written
 * to fit the matcher. That is the point: the firewall accepts the connection
 * before deciding, so what the agent sees names no policy, and a hint built
 * from invented strings would match nothing in production.
 */

const ALLOW = ["pypi.org", "files.pythonhosted.org", "*.sharepoint.com"];

const SIGNATURES = {
  urllib:
    "URLError | <urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1032)>",
  requests:
    "SSLError | HTTPSConnectionPool(host='example.com', port=443): Max retries exceeded with url: / (Caused by SSLError(SSLEOFError(8, '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1032)')))",
  curlHttps:
    "curl: (35) TLS connect error: error:0A000126:SSL routines::unexpected eof while reading",
  curlHttp: "curl: (52) Empty reply from server",
};

describe("explainBlockedEgress — names the host and the way out", () => {
  test("urllib, where only the code names the host", () => {
    const hint = explainBlockedEgress({
      code: 'urllib.request.urlopen("https://files.example.com/report.pdf")',
      errorText: SIGNATURES.urllib,
      allowOut: ALLOW,
    });
    expect(hint).toContain("files.example.com");
    expect(hint).toContain("downloadFile");
  });

  test("requests, where the error itself names the host", () => {
    const hint = explainBlockedEgress({
      code: "requests.get(url)",
      errorText: SIGNATURES.requests,
      allowOut: ALLOW,
    });
    expect(hint).toContain("example.com");
  });

  test("curl over https", () => {
    const hint = explainBlockedEgress({
      code: "curl -sS https://api.example.com/v1/data",
      errorText: SIGNATURES.curlHttps,
      allowOut: ALLOW,
    });
    expect(hint).toContain("api.example.com");
  });

  test("curl over plain http, which fails differently", () => {
    const hint = explainBlockedEgress({
      code: "curl -sS http://api.example.com/v1/data",
      errorText: SIGNATURES.curlHttp,
      allowOut: ALLOW,
    });
    expect(hint).toContain("api.example.com");
  });

  test("it says package installs still work, because they do", () => {
    // Without this the obvious next move is to stop trying to install things.
    const hint = explainBlockedEgress({
      code: 'urllib.request.urlopen("https://files.example.com/x")',
      errorText: SIGNATURES.urllib,
      allowOut: ALLOW,
    });
    expect(hint).toContain("Package installs");
  });
});

describe("explainBlockedEgress — when it must stay quiet", () => {
  test("a reset from an ALLOWED host is not a policy problem", () => {
    // PyPI resetting a connection is PyPI resetting a connection. Telling the
    // agent it was blocked sends it after the wrong thing entirely.
    const hint = explainBlockedEgress({
      code: "pip install pandas",
      errorText:
        "SSLError | HTTPSConnectionPool(host='pypi.org', port=443): Max retries exceeded with url: /simple/pandas/",
      allowOut: ALLOW,
    });
    expect(hint).toBeUndefined();
  });

  test("a wildcard entry covers its subdomains", () => {
    const hint = explainBlockedEgress({
      code: 'urllib.request.urlopen("https://contoso.sharepoint.com/file")',
      errorText: SIGNATURES.urllib,
      allowOut: ALLOW,
    });
    expect(hint).toBeUndefined();
  });

  test("an ordinary failure with no handshake signature", () => {
    const hint = explainBlockedEgress({
      code: 'requests.get("https://files.example.com")',
      errorText: "KeyError: 'total'",
      allowOut: ALLOW,
    });
    expect(hint).toBeUndefined();
  });

  test("a handshake signature with no host to blame", () => {
    const hint = explainBlockedEgress({
      code: "run_pipeline()",
      errorText: SIGNATURES.urllib,
      allowOut: ALLOW,
    });
    expect(hint).toBeUndefined();
  });

  test("an unknown policy says nothing rather than guessing", () => {
    // A sandbox this process never applied a policy to. Claiming a host is
    // blocked without knowing the list would be a confident lie.
    const hint = explainBlockedEgress({
      code: 'requests.get("https://files.example.com")',
      errorText: SIGNATURES.urllib,
      allowOut: undefined,
    });
    expect(hint).toBeUndefined();
  });
});
