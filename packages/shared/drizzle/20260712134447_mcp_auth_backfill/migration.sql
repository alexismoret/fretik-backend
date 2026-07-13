-- Backfill the MCP direct-transport columns for connections created BEFORE the
-- direct transport landed (dev only — the MCP chantier is uncommitted, so these
-- rows exist nowhere else). Idempotent.
--
-- Every pre-existing MCP connection (curated `*-mcp` + custom `mcp-generic`)
-- was OAuth-via-Nango, so its auth kind is `nango-oauth`. The discriminator is
-- the (now legacy) `nango_provider_config_key` — the only signal these old rows
-- carry, since `mcp_auth_kind` is what we're populating.
UPDATE "external_app_connections"
SET "mcp_auth_kind" = 'nango-oauth'
WHERE "mcp_auth_kind" IS NULL
  AND "nango_provider_config_key" IN (
    'notion-mcp', 'linear-mcp', 'slack-mcp', 'hubspot-mcp',
    'asana-mcp', 'attio-mcp', 'canva-mcp', 'mcp-generic'
  );

-- Curated vendors get their server URL from the catalog. Custom `mcp-generic`
-- rows keep `mcp_server_url` NULL (the URL lived only inside Nango's Connect UI
-- pre-migration); `resolveMcpTarget` rejects those with a "reconnect" error, so
-- the operator deletes + reconnects them (dev only, a handful of rows).
UPDATE "external_app_connections" AS eac
SET "mcp_server_url" = v.url
FROM (
  VALUES
    ('notion-mcp', 'https://mcp.notion.com/mcp'),
    ('linear-mcp', 'https://mcp.linear.app/mcp'),
    ('slack-mcp',  'https://mcp.slack.com/mcp'),
    ('hubspot-mcp','https://mcp.hubspot.com/mcp'),
    ('asana-mcp',  'https://mcp.asana.com/v2'),
    ('attio-mcp',  'https://mcp.attio.com/mcp'),
    ('canva-mcp',  'https://mcp.canva.com/mcp')
) AS v(key, url)
WHERE eac."nango_provider_config_key" = v.key
  AND eac."mcp_server_url" IS NULL;