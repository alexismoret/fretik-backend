import { describe, expect, test } from "bun:test";

import {
  defaultPasskeyName,
  resolvePasskeyProvider,
} from "../../src/lib/auth-passkey";
import { describeUserAgent } from "../../src/services/auth/send-security-notice";

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ANONYMOUS = "00000000-0000-0000-0000-000000000000";

describe("resolvePasskeyProvider", () => {
  test("names a known authenticator model, whatever its casing", () => {
    expect(resolvePasskeyProvider("EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4")).toBe(
      "Google Password Manager",
    );
    expect(resolvePasskeyProvider("adce0002-35bc-c60a-648b-0b25f1f05503")).toBe(
      "Chrome on Mac",
    );
  });

  test("an anonymous, unknown or missing AAGUID names nothing", () => {
    expect(resolvePasskeyProvider(ANONYMOUS)).toBeNull();
    expect(
      resolvePasskeyProvider("12345678-1234-1234-1234-123456789abc"),
    ).toBeNull();
    expect(resolvePasskeyProvider(null)).toBeNull();
    expect(resolvePasskeyProvider("")).toBeNull();
  });
});

describe("defaultPasskeyName", () => {
  test("a known AAGUID wins over every heuristic", () => {
    expect(
      defaultPasskeyName({
        aaguid: "bada5566-a7aa-401f-bd96-45619a55120d",
        transports: ["internal"],
        userAgent: MAC_SAFARI,
      }),
    ).toBe("1Password");
  });

  test("an Apple platform passkey hides its AAGUID and is still named", () => {
    for (const userAgent of [MAC_SAFARI, IPHONE_SAFARI]) {
      expect(
        defaultPasskeyName({
          aaguid: ANONYMOUS,
          transports: ["hybrid", "internal"],
          userAgent,
        }),
      ).toBe("iCloud Keychain");
    }
  });

  test("a security key plugged into a Mac is not iCloud Keychain", () => {
    expect(
      defaultPasskeyName({
        aaguid: ANONYMOUS,
        transports: ["nfc", "usb"],
        userAgent: MAC_SAFARI,
      }),
    ).toBeUndefined();
  });

  test("an anonymous passkey elsewhere stays unnamed for the UI to label", () => {
    expect(
      defaultPasskeyName({
        aaguid: ANONYMOUS,
        transports: ["internal"],
        userAgent: WINDOWS_CHROME,
      }),
    ).toBeUndefined();
  });
});

describe("describeUserAgent", () => {
  test("summarises browser and OS", () => {
    expect(describeUserAgent(MAC_SAFARI)).toBe("Safari · macOS");
    expect(describeUserAgent(IPHONE_SAFARI)).toBe("Safari · iOS");
    expect(describeUserAgent(WINDOWS_CHROME)).toBe("Chrome · Windows");
  });

  test("nothing to describe without a user agent", () => {
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent("")).toBeNull();
  });
});
