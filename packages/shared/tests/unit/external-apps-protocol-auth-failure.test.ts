import { isAuthFailure } from "@fretik/shared/lib/external-apps/detect-auth-failure";
import { describe, expect, test } from "bun:test";

/**
 * A `custom-handler` provider speaks a protocol, not HTTP, so there is no
 * status code for `isAuthFailure` to read — the protocol's own words are the
 * whole signal.
 *
 * `callCustomHandler` has always claimed this worked ("IMAP returns
 * AUTHENTICATIONFAILED, SMTP raises an EAUTH; if `isAuthFailure` matches the
 * thrown error we mark the connection"), but until these patterns existed
 * every one of those errors fell through unmatched. The failure is silent
 * and long-lived: a mailbox password rotated by IT, or an SFTP account
 * disabled by a partner, leaves the connection `active` forever — every call
 * fails, the card shows no problem, and the Reconnect button that exists for
 * exactly this is never offered.
 *
 * The strings below are what the libraries actually throw. The SSH one was
 * taken from a live OpenSSH server refusing a wrong password.
 */

const matched = (message: string): boolean =>
  isAuthFailure(new Error(message)).matched;

describe("protocol auth failures are durable and must be reported", () => {
  test("SFTP — every key and password offered was refused", () => {
    // Verbatim from `ssh2` against a live sshd, via `nango.getConnection`.
    expect(
      matched("getConnection: All configured authentication methods failed"),
    ).toBe(true);
  });

  test("FTP — 530 not logged in", () => {
    expect(matched("530 Login incorrect.")).toBe(true);
  });

  test("IMAP — AUTHENTICATIONFAILED", () => {
    expect(
      matched("Command failed: AUTHENTICATIONFAILED Invalid credentials"),
    ).toBe(true);
  });

  test("SMTP — 535 via nodemailer's EAUTH", () => {
    expect(
      matched("Invalid login: 535 5.7.8 Username and Password not accepted"),
    ).toBe(true);
  });

  test("Exchange / EWS behind Basic auth", () => {
    expect(matched("The request failed. 401 Unauthorized")).toBe(true);
  });
});

describe("what must NOT be mistaken for a dead credential", () => {
  /**
   * Every one of these is transient. Flipping the connection to `error` on
   * one asks the user to re-enter credentials that were never wrong, and
   * leaves the connection unusable until they do.
   */
  test("a server at its session limit", () => {
    expect(matched("421 Too many connections from this IP")).toBe(false);
  });

  test("the server is down or the host is wrong", () => {
    expect(matched("connect ECONNREFUSED 10.0.0.5:22")).toBe(false);
    expect(matched("connect ETIMEDOUT 10.0.0.5:22")).toBe(false);
  });

  test("a missing file is not a missing credential", () => {
    expect(matched("550 Failed to open file.")).toBe(false);
  });

  test("a TLS certificate the client would not accept", () => {
    expect(matched("self signed certificate in certificate chain")).toBe(false);
  });

  test("a number that merely ENDS in a status code", () => {
    // This is why the codes are matched on a digit boundary rather than as
    // substrings: `"530 "` is inside `"1530 bytes"`, and a plain `includes`
    // marked a healthy connection dead over a byte count.
    expect(matched("Transferred 1530 bytes")).toBe(false);
    expect(matched("Wrote 2535 lines")).toBe(false);
    expect(matched("elapsed 1401 ms")).toBe(false);
  });

  test("our own transfer deadline", () => {
    expect(
      matched("The file server did not finish within 50s. Ask for fewer files"),
    ).toBe(false);
  });

  test("our own proxy deadline, and the rate limit behind it", () => {
    // `callNangoProxy` gives up before its connection slot's lease expires.
    // Being rate-limited is the OPPOSITE of having dead credentials — the key
    // works, it worked a second ago, and it will work again shortly.
    expect(
      matched(
        "The provider did not answer within 50s. It is usually rate-limiting us",
      ),
    ).toBe(false);
    expect(matched("Request failed with status code 429")).toBe(false);
  });

  test("a body Nango refused for its size", () => {
    // HTTP 413 on the proxy route: the attachment is too big, the connection
    // is fine. Marking it dead would ask the user to re-enter credentials
    // over a file they can simply shrink.
    expect(matched("Request failed with status code 413")).toBe(false);
    expect(matched("Request entity too large (limit: 1mb)")).toBe(false);
    expect(
      matched("The request body was too large for the connector's 1 MB limit."),
    ).toBe(false);
  });
});
