/**
 * Turn a blocked outbound connection into a sentence the agent can act on.
 *
 * The sandbox's firewall does not refuse a host it disallows. It accepts the
 * TCP handshake and then kills the TLS one, so the failure surfaces as a
 * protocol error that names no policy at all. Measured on a live sandbox
 * (`scripts/smoke-sandbox-egress.ts`), a request to a disallowed host returns:
 *
 *   urllib    URLError | <urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING]
 *             EOF occurred in violation of protocol (_ssl.c:1032)>
 *   requests  SSLError | HTTPSConnectionPool(host='example.com', port=443):
 *             Max retries exceeded with url: / (Caused by SSLError(SSLEOFError(
 *             8, '[SSL: UNEXPECTED_EOF_WHILE_READING] ...
 *   curl      curl: (35) TLS connect error: error:0A000126:SSL routines::
 *             unexpected eof while reading                         (exit 35)
 *   curl http curl: (52) Empty reply from server                   (exit 52)
 *   wget      (exit 4, no message)
 *
 * DNS still resolves — the policy allows the resolver — so nothing upstream of
 * the handshake hints at it either. Left alone, a model reads these as a
 * broken server and retries, or starts debugging TLS.
 *
 * The hint is only added when a host the policy does NOT allow appears in what
 * the agent ran. A reset while installing from PyPI is a reset, and saying
 * "blocked" there would send the agent after the wrong thing.
 */

/** Signatures of a killed handshake, in the clients agent code actually uses. */
const BLOCKED_SIGNATURES = [
  /UNEXPECTED_EOF_WHILE_READING/,
  /SSLEOFError/,
  /unexpected eof while reading/i,
  /SSL_ERROR_SYSCALL/,
  /Connection reset by peer/i,
  /ECONNRESET/,
  /RemoteDisconnected/,
  /Max retries exceeded/i,
  /Empty reply from server/i,
  /curl: \((?:35|52|56|28|7)\)/,
];

/** `*.example.com` matches any depth of subdomain, never the apex. */
const hostMatches = (host: string, pattern: string): boolean => {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1));
  return h === p;
};

/** Hosts named by the code, in the order they appear. */
const hostsIn = (text: string): string[] => {
  const found: string[] = [];
  // URLs first: what the code meant to reach.
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.*-]+)/gi)) {
    const host = match[1];
    if (host !== undefined) found.push(host);
  }
  // Then the shapes the error messages themselves use, which is all a bare
  // `requests` traceback or a curl failure gives you.
  for (const match of text.matchAll(/host='([^']+)'/g)) {
    const host = match[1];
    if (host !== undefined) found.push(host);
  }
  for (const match of text.matchAll(/connection to ([a-z0-9.-]+):\d+/gi)) {
    const host = match[1];
    if (host !== undefined) found.push(host);
  }
  return found;
};

export interface BlockedEgressInput {
  /** What the agent ran; where the intended host is usually named. */
  code: string;
  /** Combined stderr / kernel error text. */
  errorText: string;
  /** The allowlist in force for this sandbox, when known. */
  allowOut: readonly string[] | undefined;
}

/**
 * One line naming the host and the way out, or `undefined` when this does not
 * look like an egress refusal.
 */
export const explainBlockedEgress = (
  input: BlockedEgressInput,
): string | undefined => {
  if (input.allowOut === undefined) return undefined;
  if (!BLOCKED_SIGNATURES.some((re) => re.test(input.errorText))) {
    return undefined;
  }

  const candidates = [...hostsIn(input.errorText), ...hostsIn(input.code)];
  const blocked = candidates.find(
    (host) => !input.allowOut?.some((entry) => hostMatches(host, entry)),
  );
  if (blocked === undefined) return undefined;

  return `The sandbox cannot reach ${blocked}: outbound network is limited to an allowlist, and that host is not on it. Fetch it from the assistant instead — \`downloadFile\` writes the bytes to \`downloads/\`, \`webFetch\` returns a page's text; both are domain tools, so activate with \`searchTools\` first. Package installs (pip, npm, apt) are unaffected.`;
};
