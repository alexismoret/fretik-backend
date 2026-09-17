/**
 * Manual smoke for the sandbox egress model: proves, against a REAL sandbox,
 * the four things the v2 design rests on and that no unit test can assert.
 *
 *   1. The egress proxy injects `network.rules` headers into requests leaving
 *      the sandbox — from the Jupyter kernel (`runCode`, urllib) AND from
 *      `commands.run` (curl). This is what lets the sandbox JWT live OUTSIDE
 *      the VM: the guest never holds it, the proxy adds it on the way out.
 *   2. The per-sandbox CA E2B terminates TLS with is trusted by those clients.
 *   3. `updateNetwork` re-applies allow/deny/rules on a RESUMED sandbox and
 *      replaces them atomically — the basis for a per-turn policy, and for
 *      revoking the JWT by dropping one rule.
 *   4. `apt-get install` works once the Debian mirrors are allowed.
 *
 * It also CAPTURES the verbatim error text a blocked host produces in each
 * client. Those strings are the input to the agent-facing hint: a refusal
 * arrives as a killed TLS handshake, never as "domain not allowed".
 *
 * Run it from `packages/shared`:
 *   bun run e2b:smoke -- --backend-url=https://<tunnel-host>
 *
 * `--backend-url` is optional; without it the Fretik-specific probes are
 * skipped and the neutral echo host still settles injection and TLS trust.
 * Exits 1 when a REQUIRED probe fails, so it can gate the transport switch.
 */

import { Sandbox } from "@e2b/code-interpreter";
import { ALL_TRAFFIC, CommandExitError } from "e2b";
import { randomUUID } from "node:crypto";
import { signSandboxJwt } from "../lib/external-apps/sandbox-jwt";
import {
  E2B_TEMPLATE,
  SANDBOX_TIMEOUT_MS,
  SANDBOX_USER,
} from "../services/e2b/client";

/** Header the echo host reflects back; proves injection without our backend. */
const SPIKE_HEADER = "X-Fretik-Spike";

/**
 * Package mirrors the probes need. Measured from the running template, not
 * guessed: its apt sources are Debian trixie on `deb.debian.org` for BOTH the
 * main and the security suite (`/debian-security`, not `security.debian.org`),
 * plus the NodeSource repo the base image adds for Node 20.
 */
const PACKAGE_HOSTS = [
  "pypi.org",
  "files.pythonhosted.org",
  "deb.debian.org",
  "deb.nodesource.com",
];

/**
 * E2B terminates TLS for every host carrying a `transform` rule and signs it
 * with a per-sandbox CA, which it installs in the SYSTEM trust store. urllib
 * and curl read that store and are fine; `requests` reads certifi's own bundle
 * and fails with CERTIFICATE_VERIFY_FAILED (measured). Pointing the two
 * bundle variables at the system store is what closes the gap.
 */
const SYSTEM_CA_BUNDLE = "/usr/lib/ssl/cert.pem";
const CA_ENVS: Record<string, string> = {
  REQUESTS_CA_BUNDLE: SYSTEM_CA_BUNDLE,
  NODE_EXTRA_CA_CERTS: SYSTEM_CA_BUNDLE,
};

interface Probe {
  name: string;
  /** `null` = captured for the record, no verdict. */
  pass: boolean | null;
  /** `true` when a failure must fail the run. */
  required: boolean;
  detail: string;
}

const probes: Probe[] = [];

const record = (
  name: string,
  pass: boolean | null,
  detail: string,
  required = false,
): void => {
  probes.push({ name, pass, required, detail });
  const mark = pass === null ? "INFO" : pass ? "PASS" : "FAIL";
  console.info(`[${mark}] ${name}${detail === "" ? "" : ` — ${detail}`}`);
};

const arg = (name: string): string | undefined => {
  const hit = Bun.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(`--${name}=`.length);
};

const flag = (name: string): boolean => Bun.argv.includes(`--${name}`);

/** One line, collapsed — these strings land in a table and in a test fixture. */
const oneLine = (text: string, max = 220): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `commands.run` THROWS on a non-zero exit, and half the probes here expect
 * one. Unwrap it back into a result instead of letting it end the run.
 */
const bash = async (
  sbx: Sandbox,
  command: string,
  timeoutMs = 120_000,
): Promise<BashResult> => {
  try {
    const res = await sbx.commands.run(command, {
      user: SANDBOX_USER,
      timeoutMs,
    });
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
};

interface PyResult {
  out: string;
  err: string;
}

const py = async (sbx: Sandbox, code: string): Promise<PyResult> => {
  const exec = await sbx.runCode(code, { timeoutMs: SANDBOX_TIMEOUT_MS });
  const err = exec.error
    ? `${exec.error.name}: ${exec.error.value}`
    : exec.logs.stderr.join("");
  return { out: exec.logs.stdout.join(""), err };
};

/**
 * The body a blocked backend call would produce if the header never arrived.
 * `/sandbox/exec` checks the bearer before anything else, so "Missing bearer
 * token" is the one answer that proves the injection did NOT happen.
 */
const NO_BEARER = "Missing bearer token";

const backendProbeCode = (backendUrl: string, turnId: string): string => `
import json, urllib.request, urllib.error
body = json.dumps({"kind": "read", "action": "spike.nonexistent", "args": {}, "turnId": ${JSON.stringify(turnId)}}).encode()
req = urllib.request.Request(
    ${JSON.stringify(`${backendUrl.replace(/\/$/, "")}/sandbox/exec`)},
    data=body,
    headers={"Content-Type": "application/json", "User-Agent": "fretik-apps-sdk/1.0"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print("STATUS", r.status, r.read().decode("utf-8", "replace")[:400])
except urllib.error.HTTPError as e:
    print("STATUS", e.code, e.read().decode("utf-8", "replace")[:400])
except Exception as e:
    print("TRANSPORT", type(e).__name__, str(e)[:400])
`;

const main = async (): Promise<void> => {
  const backendUrl =
    arg("backend-url") ?? Bun.env.FRETIK_BACKEND_INTERNAL_URL ?? "";
  const echoHost = arg("echo-host") ?? "httpbin.org";
  const keepAlive = flag("keep");

  let backendHost = "";
  if (backendUrl !== "") {
    try {
      backendHost = new URL(backendUrl).hostname;
    } catch {
      console.error(`--backend-url is not a URL: ${backendUrl}`);
      process.exit(2);
    }
  }

  const turnId = `spike-${randomUUID()}`;
  const hasSecret =
    Bun.env.SANDBOX_JWT_SECRET !== undefined &&
    Bun.env.SANDBOX_JWT_SECRET !== "";
  /** The backend probes also need somewhere to send the injected credential. */
  const canProbeBackend = hasSecret && backendHost !== "";

  const mintJwt = async (): Promise<string> =>
    signSandboxJwt({
      conversationId: randomUUID(),
      teamId: randomUUID(),
      userId: randomUUID(),
      organizationId: randomUUID(),
      turnId,
    });

  const jwt1 = hasSecret ? await mintJwt() : "";

  console.info(
    `template=${E2B_TEMPLATE} echo=${echoHost} backend=${backendHost === "" ? "<skipped>" : backendHost} jwt=${hasSecret ? `signed (${jwt1.length.toString()} chars)` : "<no SANDBOX_JWT_SECRET>"}`,
  );

  const baseAllow = [echoHost, ...PACKAGE_HOSTS];
  const allowOut = backendHost === "" ? baseAllow : [...baseAllow, backendHost];

  // The echo host carries BOTH headers: the marker proves injection happened,
  // and a real `Authorization: Bearer <jwt>` proves a full-size JWT survives
  // the proxy intact — the header value limit is 2048 chars and ours is ~400.
  const buildRules = (
    bearer: string,
  ): Record<string, { transform: { headers: Record<string, string> } }[]> => {
    const echoHeaders: Record<string, string> = { [SPIKE_HEADER]: turnId };
    if (bearer !== "") echoHeaders["Authorization"] = `Bearer ${bearer}`;
    const rules: Record<
      string,
      { transform: { headers: Record<string, string> } }[]
    > = {
      [echoHost]: [{ transform: { headers: echoHeaders } }],
    };
    if (backendHost !== "" && bearer !== "") {
      rules[backendHost] = [
        { transform: { headers: { Authorization: `Bearer ${bearer}` } } },
      ];
    }
    return rules;
  };

  // ---- A1: create, with public traffic off ------------------------------
  // `allowPublicTraffic: false` is create-only and is the one option that
  // could cut the SDK off from the Jupyter port it reaches over the sandbox's
  // public URL. If it does, recreate without it rather than losing the run.
  let publicTrafficOff = true;
  let sbx = await Sandbox.create(E2B_TEMPLATE, {
    metadata: { conversationId: turnId, environment: "spike" },
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lifecycle: { onTimeout: "pause", autoResume: true },
    allowInternetAccess: true,
    envs: CA_ENVS,
    network: {
      allowOut,
      denyOut: [ALL_TRAFFIC],
      rules: buildRules(jwt1),
      allowPublicTraffic: false,
    },
  });
  console.info(`sandbox=${sbx.sandboxId}`);

  try {
    const smoke = await py(sbx, "print('kernel-ok')");
    record(
      "A1 allowPublicTraffic:false keeps runCode working",
      smoke.out.includes("kernel-ok"),
      oneLine(smoke.out + smoke.err),
    );
  } catch (err) {
    publicTrafficOff = false;
    record(
      "A1 allowPublicTraffic:false keeps runCode working",
      false,
      `recreating with public traffic on: ${oneLine(err instanceof Error ? err.message : String(err))}`,
    );
    await sbx.kill();
    sbx = await Sandbox.create(E2B_TEMPLATE, {
      metadata: { conversationId: turnId, environment: "spike" },
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause", autoResume: true },
      allowInternetAccess: true,
      envs: CA_ENVS,
      network: { allowOut, denyOut: [ALL_TRAFFIC], rules: buildRules(jwt1) },
    });
    console.info(`sandbox(recreated)=${sbx.sandboxId}`);
  }

  try {
    // ---- A2: header injection on a neutral echo host --------------------
    const echoUrl = `https://${echoHost}/headers`;
    // Print the marker header ALONE. Slicing the raw body instead pushed it
    // out of the window as soon as the rules carried a ~470-char JWT too, and
    // the probe failed on its own formatting.
    const kernelEcho = await py(
      sbx,
      `import json, urllib.request\ntry:\n    d = json.loads(urllib.request.urlopen(${JSON.stringify(echoUrl)}, timeout=30).read().decode())\n    print("MARKER", d.get("headers", {}).get(${JSON.stringify(SPIKE_HEADER)}, "<absent>"))\nexcept Exception as e:\n    print("ERR", type(e).__name__, str(e)[:300])`,
    );
    record(
      "A2a proxy injects headers (kernel, urllib)",
      kernelEcho.out.includes(turnId),
      oneLine(kernelEcho.out + kernelEcho.err),
      true,
    );

    const curlEcho = await bash(
      sbx,
      `curl -sS -m 30 ${echoUrl} | python3 -c "import json,sys; print('MARKER', json.load(sys.stdin).get('headers',{}).get('${SPIKE_HEADER}','<absent>'))"`,
    );
    record(
      "A2b proxy injects headers (bash, curl)",
      curlEcho.stdout.includes(turnId),
      oneLine(curlEcho.stdout + curlEcho.stderr),
      true,
    );

    // A whole JWT, not a marker: this is the value the design moves out of the
    // VM, and a truncated or re-encoded one would fail at the backend with an
    // error that looks nothing like a proxy problem. Compare length + tail so
    // the credential never lands in the log.
    if (hasSecret) {
      const expected = `Bearer ${jwt1}`;
      const authEcho = await py(
        sbx,
        `import json, urllib.request\ntry:\n    d = json.loads(urllib.request.urlopen(${JSON.stringify(echoUrl)}, timeout=30).read().decode())\n    a = d.get("headers", {}).get("Authorization", "")\n    print("AUTH_LEN", len(a))\n    print("AUTH_TAIL", a[-24:])\nexcept Exception as e:\n    print("ERR", type(e).__name__, str(e)[:300])`,
      );
      const lengthOk = authEcho.out.includes(
        `AUTH_LEN ${expected.length.toString()}`,
      );
      const tailOk = authEcho.out.includes(`AUTH_TAIL ${expected.slice(-24)}`);
      record(
        "A2c a full-size JWT survives injection intact",
        lengthOk && tailOk,
        `expected ${expected.length.toString()} chars — ${oneLine(authEcho.out.replace(expected.slice(-24), "…"))}`,
        true,
      );
    } else {
      record("A2c full JWT injection", null, "skipped (no SANDBOX_JWT_SECRET)");
    }

    // ---- A3: whose trust store accepts E2B's per-sandbox CA -------------
    const requestsEcho = await py(
      sbx,
      `import requests\ntry:\n    print("OK", requests.get(${JSON.stringify(echoUrl)}, timeout=30).text[:400])\nexcept Exception as e:\n    print("ERR", type(e).__name__, str(e)[:300])`,
    );
    // Without REQUESTS_CA_BUNDLE this fails with CERTIFICATE_VERIFY_FAILED:
    // certifi's bundle does not carry E2B's per-sandbox CA. Required, because
    // `requests` is the reflex of any model writing Python against an HTTP API.
    record(
      "A3a requests trusts the proxy CA (REQUESTS_CA_BUNDLE)",
      requestsEcho.out.startsWith("OK"),
      oneLine(requestsEcho.out + requestsEcho.err),
      true,
    );

    const issuer = await bash(
      sbx,
      `curl -sS -v -m 30 -o /dev/null ${echoUrl} 2>&1 | grep -iE "issuer|subject:" | head -4`,
    );
    record(
      "A3b TLS is terminated by the proxy (cert issuer)",
      null,
      oneLine(issuer.stdout + issuer.stderr),
    );

    const certEnv = await py(
      sbx,
      `import os, ssl\nprint("SSL_CERT_FILE=", os.environ.get("SSL_CERT_FILE"))\nprint("REQUESTS_CA_BUNDLE=", os.environ.get("REQUESTS_CA_BUNDLE"))\nprint("paths=", ssl.get_default_verify_paths())`,
    );
    record(
      "A3c kernel trust-store env",
      null,
      oneLine(certEnv.out + certEnv.err),
    );

    // ---- A4: the same injection, all the way to our backend -------------
    if (canProbeBackend) {
      const kernelBackend = await py(sbx, backendProbeCode(backendUrl, turnId));
      record(
        "A4a JWT injected into /sandbox/exec (kernel)",
        !kernelBackend.out.includes(NO_BEARER) &&
          kernelBackend.out.includes("STATUS"),
        oneLine(kernelBackend.out + kernelBackend.err),
        true,
      );

      const curlBackend = await bash(
        sbx,
        `curl -sS -m 60 -o - -w "\\nHTTP:%{http_code}" -X POST ${backendUrl.replace(/\/$/, "")}/sandbox/exec -H 'Content-Type: application/json' -A 'fretik-apps-sdk/1.0' -d '{"kind":"read","action":"spike.nonexistent","args":{},"turnId":"${turnId}"}'`,
      );
      record(
        "A4b JWT injected into /sandbox/exec (curl)",
        !curlBackend.stdout.includes(NO_BEARER) && curlBackend.stdout !== "",
        oneLine(curlBackend.stdout + curlBackend.stderr),
        true,
      );
    } else {
      record("A4 backend injection", null, "skipped (no backend url / secret)");
    }

    // ---- A5: what a blocked host actually looks like --------------------
    const blockedUrl = "https://example.com";
    const sigUrllib = await py(
      sbx,
      `import urllib.request\ntry:\n    urllib.request.urlopen(${JSON.stringify(blockedUrl)}, timeout=25)\n    print("UNEXPECTED: reachable")\nexcept Exception as e:\n    print(type(e).__name__, "|", str(e)[:300])`,
    );
    record(
      "A5a SIGNATURE urllib",
      null,
      oneLine(sigUrllib.out + sigUrllib.err),
    );

    const sigRequests = await py(
      sbx,
      `import requests\ntry:\n    requests.get(${JSON.stringify(blockedUrl)}, timeout=25)\n    print("UNEXPECTED: reachable")\nexcept Exception as e:\n    print(type(e).__name__, "|", str(e)[:300])`,
    );
    record(
      "A5b SIGNATURE requests",
      null,
      oneLine(sigRequests.out + sigRequests.err),
    );

    const sigCurl = await bash(sbx, `curl -sS -m 25 ${blockedUrl}`);
    record(
      "A5c SIGNATURE curl https",
      null,
      `exit=${sigCurl.exitCode} ${oneLine(sigCurl.stderr + sigCurl.stdout)}`,
    );

    const sigCurlHttp = await bash(sbx, `curl -sS -m 25 http://example.com`);
    record(
      "A5d SIGNATURE curl http (plain)",
      null,
      `exit=${sigCurlHttp.exitCode} ${oneLine(sigCurlHttp.stderr + sigCurlHttp.stdout)}`,
    );

    const sigWget = await bash(sbx, `wget -q -T 25 -O /dev/null ${blockedUrl}`);
    record(
      "A5e SIGNATURE wget",
      null,
      `exit=${sigWget.exitCode} ${oneLine(sigWget.stderr + sigWget.stdout)}`,
    );

    const sigDns = await bash(sbx, `getent hosts example.com || echo "no-dns"`);
    record("A5f DNS for a blocked host", null, oneLine(sigDns.stdout));

    // ---- A9: apt, with only the Debian mirrors allowed -------------------
    const sources = await bash(
      sbx,
      `cat /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | grep -vE "^#|^$" | head -8`,
    );
    record("A9a apt sources", null, oneLine(sources.stdout));

    const apt = await bash(
      sbx,
      `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends jq >/dev/null && jq --version`,
      240_000,
    );
    record(
      "A9b apt-get install works",
      apt.exitCode === 0,
      `exit=${apt.exitCode} ${oneLine(apt.stdout + apt.stderr)}`,
      true,
    );

    const pip = await bash(
      sbx,
      `python3 -m pip install --quiet --disable-pip-version-check tabulate 2>&1 | tail -2; python3 -c "import tabulate; print('pip-ok', tabulate.__version__)"`,
      180_000,
    );
    record(
      "A9c pip install works",
      pip.stdout.includes("pip-ok"),
      oneLine(pip.stdout + pip.stderr),
      true,
    );

    // ---- E-prep: which of the proposed programs are already there -------
    const programs = await bash(
      sbx,
      `for p in convert gs qpdf zip unzip rg jq ffmpeg soffice pandoc tesseract; do printf "%s=%s " "$p" "$(command -v $p >/dev/null && echo yes || echo no)"; done; printf "fonts=%s " "$(fc-list 2>/dev/null | grep -ciE 'liberation|dejavu')"; printf "magick=%s " "$(convert -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"; printf "pdfpolicy=%s" "$(grep -h 'pattern=\\"PDF\\"' /etc/ImageMagick-*/policy.xml 2>/dev/null | head -1 || echo none)"`,
    );
    record(
      "E-prep programs already in template",
      null,
      oneLine(programs.stdout),
    );

    // ---- A7: how large an allowOut the API accepts ----------------------
    const bigAllow = [
      ...allowOut,
      ...Array.from(
        { length: 70 },
        (_, i) => `spike-${i.toString()}.example.com`,
      ),
    ];
    try {
      await sbx.updateNetwork({
        allowOut: bigAllow,
        denyOut: [ALL_TRAFFIC],
        rules: buildRules(jwt1),
      });
      record(
        "A7 large allowOut accepted",
        true,
        `${bigAllow.length.toString()} entries`,
      );
    } catch (err) {
      record(
        "A7 large allowOut accepted",
        false,
        oneLine(err instanceof Error ? err.message : String(err)),
      );
    }

    // ---- A6: pause → resume → updateNetwork, and atomic replacement -----
    await sbx.pause();
    const resumed = await Sandbox.connect(sbx.sandboxId, {
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    record(
      "A6a pause + connect",
      true,
      `state restored for ${resumed.sandboxId}`,
    );

    const jwt2 = hasSecret ? await mintJwt() : "";
    // The new list DROPS the echo host and ADDS api.github.com: if the update
    // merged instead of replacing, the echo host would still answer.
    const flippedAllow = [
      ...PACKAGE_HOSTS,
      "api.github.com",
      ...(backendHost === "" ? [] : [backendHost]),
    ];
    const started = Date.now();
    await resumed.updateNetwork({
      allowOut: flippedAllow,
      denyOut: [ALL_TRAFFIC],
      rules:
        backendHost === "" || jwt2 === ""
          ? {}
          : {
              [backendHost]: [
                { transform: { headers: { Authorization: `Bearer ${jwt2}` } } },
              ],
            },
    });
    const updateMs = Date.now() - started;
    record(
      "A6b updateNetwork on a resumed sandbox",
      true,
      `${updateMs.toString()} ms`,
    );

    const info = await resumed.getInfo();
    const infoAllow = info.network?.allowOut ?? [];
    record(
      "A6c getInfo reflects the new policy",
      infoAllow.includes("api.github.com") && !infoAllow.includes(echoHost),
      oneLine(`allowOut=${infoAllow.join(",")}`),
      true,
    );

    const nowAllowed = await bash(
      resumed,
      `curl -sS -m 25 -o /dev/null -w "%{http_code}" https://api.github.com`,
    );
    record(
      "A6d newly allowed host reachable",
      nowAllowed.stdout.trim().startsWith("2") ||
        nowAllowed.stdout.trim().startsWith("4"),
      `http=${oneLine(nowAllowed.stdout)} ${oneLine(nowAllowed.stderr)}`,
      true,
    );

    const nowBlocked = await bash(
      resumed,
      `curl -sS -m 25 https://${echoHost}/headers`,
    );
    record(
      "A6e dropped host is blocked (atomic replace)",
      nowBlocked.exitCode !== 0,
      `exit=${nowBlocked.exitCode} ${oneLine(nowBlocked.stderr + nowBlocked.stdout)}`,
      true,
    );

    if (canProbeBackend) {
      const rotated = await py(resumed, backendProbeCode(backendUrl, turnId));
      record(
        "A6f rotated JWT is the one injected",
        !rotated.out.includes(NO_BEARER) && rotated.out.includes("STATUS"),
        oneLine(rotated.out + rotated.err),
        true,
      );

      // ---- A8: dropping the rule revokes the credential -----------------
      await resumed.updateNetwork({
        allowOut: flippedAllow,
        denyOut: [ALL_TRAFFIC],
      });
      const revoked = await py(resumed, backendProbeCode(backendUrl, turnId));
      record(
        "A8 removing the rule revokes the JWT",
        revoked.out.includes(NO_BEARER),
        oneLine(revoked.out + revoked.err),
        true,
      );
    } else {
      record(
        "A6f/A8 JWT rotation + revocation",
        null,
        "skipped (no backend url / secret)",
      );
    }

    if (!keepAlive) await resumed.kill();
  } finally {
    if (!keepAlive) {
      await sbx.kill().catch(() => undefined);
    } else {
      console.info(`--keep: sandbox ${sbx.sandboxId} left running`);
    }
  }

  console.info("\n──────── summary ────────");
  for (const p of probes) {
    const mark = p.pass === null ? "info" : p.pass ? "pass" : "FAIL";
    console.info(`${mark.padEnd(4)}  ${p.name}`);
  }
  console.info(
    `publicTrafficOff=${publicTrafficOff.toString()} — the transport switch needs every required probe green.`,
  );

  const failed = probes.filter((p) => p.required && p.pass === false);
  if (failed.length > 0) {
    console.error(
      `\n${failed.length.toString()} required probe(s) failed: ${failed.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }
};

await main();
