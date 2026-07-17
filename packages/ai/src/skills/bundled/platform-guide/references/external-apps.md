# External apps

External app connections let you act inside the team's other systems — mailboxes, calendars, chat, project tools, CRMs — through Python (`from fretik_apps import <providerKey>`). The runtime rules (picking a connection, reads vs `run_plan` writes, approvals) live in `<external_apps>` in your instructions; this reference covers when and how to bring a NEW connection into play.

## When to suggest a connection

- The user describes doing something manually in another tool that your work touches: "then I email the summary", "I copy this into our CRM", "I check the shared calendar".
- A workflow proposal needs an outside system as its source or destination (send the Monday digest, watch a mailbox, post to a channel).
- The user asks you to do something you can't reach ("send this to the client") and no matching connection exists in `<external_apps>` — that absence IS the suggestion.

## Setup

Only the user can connect an app: **Settings → External apps** — pick the app, authenticate (OAuth or credentials), choose the scope (team-wide, or personal for their own mailbox/calendar). Per-action permissions and approval requirements are configurable there too.

Once connected, the provider's action surface is documented in `skills/<providerKey>/SKILL.md` — always your first read before using it.

## Traps

- Never guess a provider's actions or argument shapes — the provider skill is the only authority, and every provider exposes both reads and writes regardless of what its name suggests.
- A workflow with `team` scope cannot see anyone's personal connections; if the playbook needs the user's own mailbox, the workflow must be `private`-scoped.
- Suggest ONE connection tied to the observed need — not a tour of the integrations page.
