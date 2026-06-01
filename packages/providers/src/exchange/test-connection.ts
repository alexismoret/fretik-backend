import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";
import { Folder, FolderId, WellKnownFolderName } from "ews-javascript-api";
import { idOnlyPropertySet, withService } from "./client";
import { parseEwsConfig } from "./config";

/**
 * Validate user-supplied Exchange credentials by binding the Inbox folder —
 * a single authenticated EWS round-trip that succeeds only when the URL is
 * reachable (auto-resolved if blank), the Basic login is accepted, and the
 * mailbox exists.
 * A bad URL / self-signed cert / wrong password all surface here.
 */
export const testExchangeCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  let cfg: ReturnType<typeof parseEwsConfig>;
  try {
    cfg = parseEwsConfig(credentials, connection_config);
  } catch (error) {
    return {
      ok: false,
      scope: "ews",
      message:
        error instanceof Error
          ? error.message
          : "Invalid Exchange configuration",
    };
  }

  try {
    await withService(cfg, async (service) => {
      await Folder.Bind(
        service,
        new FolderId(WellKnownFolderName.Inbox),
        idOnlyPropertySet(),
      );
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      scope: "ews",
      message:
        error instanceof Error ? error.message : "Exchange connection failed",
    };
  }
};
