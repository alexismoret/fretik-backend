# Sharing a file, and who can see it

Read this before any share / grant / revoke request. Every choice here is one
a user can be held to afterwards, so none of them has a safe guess.

## Two different acts

**`create_share_link`** mints a URL. Anyone the URL reaches gets in, under the
`scope` you picked. Nobody is named, and nothing is emailed.

**`grant_item_access`** gives NAMED people access and, unless you turn it off,
emails them an invitation from the connected account.

Reach for the link when the user says "send me a link" or wants to paste it
somewhere. Reach for the grant when they name people.

## `create_share_link` — the two knobs

`link_type` is what the holder can do:

| value   | effect                                     |
| ------- | ------------------------------------------ |
| `view`  | read only (the default, and usually right) |
| `edit`  | the holder can change the document         |
| `embed` | an iframe-able view link, web pages only   |

`scope` is who the link works for:

| value          | effect                                                        |
| -------------- | ------------------------------------------------------------- |
| `organization` | anyone signed into the tenant. The safe default.              |
| `users`        | only the people already granted access — pair it with a grant |
| `anonymous`    | anyone holding the URL, no sign-in, no trace of who opened it |

**`anonymous` only on an explicit request.** Many tenants disable it outright
and answer `accessDenied` / `invalidRequest` — that is a policy decision, not
a bug to route around. Say the tenant blocks public links and offer
`organization` instead.

`expiration_date` takes a calendar day (`2026-03-31`) and the link dies at the
end of it. Offer one whenever the user shares outside their own team.

```python
run_plan([sharepoint.create_share_link.op(
    drive_id="b!x…", item_id="01ABC…",
    link_type="view", scope="organization", expiration_date="2026-03-31",
)])
```

The result's `link_url` is what you hand back to the user.

## `grant_item_access` — the message is an email

```python
run_plan([sharepoint.grant_item_access.op(
    drive_id="b!x…", item_id="01ABC…",
    emails=["marie@client.com"], role="read",
    message="The signed MSA, as agreed this morning.",
)])
```

- `role`: `read` or `write`. Default `read` — raise it only when asked.
- `message` is sent to the recipients **from the connected account**, so it
  reads as if the account holder wrote it. One factual line about the
  document. No greeting theatre, no signature you invented.
- `send_invitation=False` grants silently, with no email. Use it when the user
  will tell the person themselves.
- `require_sign_in=True` (the default) forces authentication. Turning it off
  on an external address makes the grant effectively public.

## Reading and undoing access

`list_permissions` returns everything on the item: direct grants, sharing
links, and permissions inherited from a parent folder or the site.

```python
for p in sharepoint.list_permissions(drive_id="b!x…", item_id="01ABC…"):
    print(p.id, p.roles, p.granted_to, p.link_scope, "inherited:", p.inherited)
```

`revoke_item_access(permission_id=…)` removes ONE of them — a person's grant
or a link, depending on which row you pass.

**A row with `inherited: True` cannot be revoked here.** It comes from a
parent folder or from site membership; removing it means changing that parent
in SharePoint, which is an administrator's job. Say so rather than calling
`revoke_item_access` and reporting the failure as a bug.

## What is NOT reachable

Site-level permissions (`/sites/{id}/permissions`) are application-only and
need `Sites.FullControl.All`, which this integration deliberately does not
request. "Who can see this whole site" is answered in SharePoint's own
permission UI, by an administrator.
