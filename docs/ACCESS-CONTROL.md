# Access control

Who may do what in Fretik: one engine decides it for every route, tool and
list, from the same rules. This page is the map: the model, where each
decision lives, how to extend it without opening a hole, and what is left to
do. The code is the reference; every file named here has a header that says
more.

## 1. The model

### A principal, per request

`authz/load-principal.ts` builds a **principal** for the person a request, a
tool call or a job acts for: their organization role (owner, admin, member,
guest), their role in each team (lead, member, viewer), their level in each
project, and what they reach through each team's content policy. It is cached
in Redis against the organization's **access version**, which every change to
who belongs where bumps (`bumpAccessVersion`), so a stale principal never
outlives the change that made it stale.

Internal callers act as a named **system principal** (`authz/system-principals.ts`):
there is no "no requester means full trust" path, and every trusted entry
point sits in that one list. A team's agent (`authz/team-agent.ts`) and a
project's (`authz/project-agent.ts`) act with what the whole team, or the
whole project, reaches.

### Four levels, one rule set

Each kind of item offers the levels that mean something for it (its adapter's
`offeredLevels`, `authz/resources/`):

| Level  | File, folder            | Page, workflow                    | Chat      | Collection        | Project                               |
| ------ | ----------------------- | --------------------------------- | --------- | ----------------- | ------------------------------------- |
| `view` | read                    | read (a workflow's runs too)      | read      | read its records  | read what is open to it               |
| `use`  |                         | run it (a page's actions, a form) | take part |                   | take part: its chats, one's own files |
| `edit` | change                  | change                            |           | write its records | its instructions and notes            |
| `full` | share, restrict, delete | share, restrict, delete           |           |                   | its settings, people, archive, delete |

A chat is its owner's to share and delete; a collection's structure is its
team's (`full` through the team role), never a grantee's.

`authz/rules.ts` is the whole rule set, as one pure function: the owner has
full access; explicit **grants** add to it (to the person, their teams, their
projects, the whole organization); and unless the item is **restricted**, it
inherits from its folder, else its project, else its team. The highest wins;
there is no deny rule. Two ceilings cap the result, whatever is shared:

- a restricted workflow runs as its owner, so anyone else only views it;
- taking part in a chat is for the people who work where it lives (its
  project's people, else its team's); anyone else reads it.

A **guest** is also held to their own terms at every door that writes a
grant (never more than `edit`; `authz/guests.ts`).

**Admins read nothing by role.** They run the structure (people, teams,
policies) through capabilities; their access to content comes from their own
team roles and grants, like anyone's.

### Capabilities and policies

What is not about one item (inviting, creating a team, reading the journal,
publishing a page) is a **capability** (`authz/capabilities.ts`), decided from
two keys: the person's role, and the organization's **access policy**
(`schemas/access-policy.ts`, stored sparse, so a default that changes still
reaches every organization that never touched it). The defaults reproduce what
the product allowed before the engine. Organization admins count as leads of
every team for a team's capabilities.

### Refusals

An item the person cannot see answers **404**, like one that does not exist.
Anything else refused answers **403 `ACCESS_DENIED`** with an `access` payload
(`authz/refusals.ts`): the reason (`INSUFFICIENT_LEVEL`, `ROLE_REQUIRED`,
`POLICY_DISABLED`, `GUEST_RESTRICTED`, `LEVEL_CAP`, `CANNOT_EXCEED_OWN`), the
level or role that would do, whom to ask, and whether a request makes sense.
The app words it; the assistant reads the same payload.

## 2. Where each decision lives

| Question                                       | Where                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| What level does this person have on this item? | `authz/rules.ts`, through `authz/access.ts` (`requireAccess`)              |
| May they do this, beyond one item?             | `authz/capabilities.ts`, through `authz/gates.ts`                          |
| Which rows may they list?                      | `authz/sql.ts`, `authz/drive-sql.ts` (held to the rules by tests)          |
| Where does new content land, and may it?       | `authz/placement.ts`                                                       |
| Which rule guards this route?                  | `authz/http.ts` (`access.*`), declared on every route                      |
| Who may share, how far, with what?             | `services/access/sharing/`                                                 |
| Asking for access, and answering               | `services/access/requests/`                                                |
| Guests and invitations by email                | `services/access/guests/`, `lib/auth-*.ts`                                 |
| What the assistant may read and search         | vector audiences (`services/ai-vectors/acl.ts`), `authz/sql-tool-scope.ts` |
| The journal of every change                    | `services/access/record-event.ts`, read by `services/access/journal/`      |

The app decides nothing: it shows, hides or locks an action from the
decisions the server sends (`GET /access/me`, each item's share model), and a
refusal it did not predict still arrives as a 403 it can explain.

## 3. Extending it

**A new route.** Declare its rule in the route definition:
`access.resource(type, level)`, `access.capability(key)`, `access.session(why)`,
`access.handler(why)` when the service decides, `access.public(why)` or
`access.internal`. The route-coverage test of each service fails on a route
without one. A handler that names a resource by id acts in that resource's
own team (`teamOfResource`), never the caller's active one.

**A new service.** Take a `principal` and decide with the engine
(`requireAccess`, `requireCapability`). A background job passes a system
principal by name.

**A new shareable type.** Add its adapter under `authz/resources/` (how to
load a node's facts), its grant store under `services/access/sharing/grant-stores/`
if its grants live elsewhere, its list predicates, and the agreement test that
holds the SQL to the rules. Add it to `SHARING_RESOURCE_TYPES`, to the vector
audiences if it is searched, and to `resourceUrl` for its emails.

**A new capability.** Declare it in `schemas/access.ts` and decide it in
`authz/capabilities.ts` (a policy setting if admins should move it); it then
appears in `/access/me`, in the roles grid and in the app's
`access.capabilities.*` labels, which both locales need.

**A change to who belongs where.** Go through Better Auth's adapter
(`lib/org-adapter.ts`), never its endpoints, bump the access version, and
journal it (`recordAccessEvent`) in the same transaction when the write is
ours.

## 4. Better Auth

Better Auth keeps identity, sessions, organization membership, the
organization role and invitations. Fretik's own routes change everything else,
decided by the engine and journaled. So Better Auth's endpoints that change
who belongs where are **closed** (`lib/auth-replaced-endpoints.ts`: invite,
cancel an invitation, change a role, remove a member, create or rename a
team, add or remove a team member); what stays open is what the app calls
(accepting and declining an invitation, removing a team, the organization's
own settings) and every read. In front of them:

- `lib/auth-hooks.ts` (`before`): the closed endpoints, and accepting a team
  invitation as someone already in the organization;
- `lib/auth-after-hooks.ts` (`after`): leaving the organization (journaled
  like a removal), and the directory answered to a guest with themselves alone.

## 5. The journal

Every change to who may do what is recorded in `access_audit_log`
(`services/access/record-event.ts`), in the transaction that makes it when
the write is ours, right after when Better Auth's makes it. Names are kept as
they were at the time; nothing of an item's content is ever recorded.

The organization's admins read it (`audit.read`, `GET /access/journal`, the
app's Settings → Access journal). An item is named only to a reader who can
open it now: an admin reads that a private file was shared, by whom and with
whom, never which file.

## 6. Tests that hold it together

- `tests/unit/authz-rules`: the rules as a table.
- `tests/integration/authz/list-agreement` and `drive-agreement`: the SQL list
  filters agree with the rules, for every kind of person and level.
- The route-coverage tests of `api` and `ai`: no route without a rule.
- `tests/integration/access/`: sharing, requests, shared with me, guests,
  the journal.
- `tests/integration/authz/organization-isolation`: grants naming another
  organization's people, planted by hand, give them nothing.

## 7. Follow-ups, on purpose not done yet

**Dropping the legacy privacy columns** (`pages.user_id`, `workflows.user_id`).
They still mean "private to this person" for the code of the release before
the engine, which runs during a deploy and on a rollback, so
`authz/legacy-privacy.ts` reads either column as restricting and writes both.
Per `OPERATIONS.md` §4, a column is dropped in steps, one release each:

1. Stop reading it: backfill what the previous release wrote alone
   (`access_restricted` and `owner_user_id` from `user_id`), then read
   `access_restricted` only. Keep writing `user_id` so a rollback still reads
   the same rows.
2. Stop writing it.
3. Drop it.

**Row-level security by organization** for the application's database role,
as defense in depth under the engine. Every query already filters by
organization or team, and the isolation suite above holds the engine to it;
Postgres enforcing it too would need every connection to carry the
organization, which the pooled connections do not yet.

**Guests.** An expired guest stays a member with nothing left to open (a
cleanup job could remove them); Better Auth's `membershipLimit` counts guests
and the teams' agents; guests are not billed (billing is out of scope).

**Seen from another team.** A member's chat list is their active team's (a
chat of another team's project is reached from the project); a guest picks no
model (the model list is a team's).
