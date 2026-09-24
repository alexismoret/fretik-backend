# fretik-backend

Bun monorepo (`packages/*`). Each package keeps its own `CLAUDE.md`; this file
holds only what applies to all of them.

## Toolchain: the latest Bun, always

CI installs `bun-version: latest` (`.github/workflows/backend.yml`), and the
pre-push hook runs every package's `check` and unit `test`. Run them on an
older Bun and they are not the same suites: on 1.3.x, `bun test --isolate`
lets `mock.module` doubles leak between files, so `api/auth-boundary`,
`api/organization-sandbox-policy` and `shared/governor-policy` fail at random
seeds on a clean `main` and block every push. They pass on 1.4.

**Before running tests or pushing, check `bun --version` against the latest
release (`npm view bun version`) and upgrade if it is behind.** A red suite on
an outdated Bun is not a result; never push past the hook with `--no-verify`.

- Locally: `bun upgrade`.
- In a Claude Code cloud container, `bun upgrade` fails twice over: the
  environment sets `BUN_OPTIONS=--smol`, which it reads as an extra argument,
  and the proxy refuses the GitHub download even with `BUN_OPTIONS=` cleared.
  Install it from npm instead and copy the binary over the one on the `PATH`:

  ```sh
  npm i -g bun@latest
  cp "$(npm root -g)/bun/bin/bun.exe" "$(readlink -f "$(command -v bun)")"
  bun --version
  ```

## Access control: one engine, every door

Who may do what is decided by the access engine (`@fretik/shared/authz`) for
every route, service, assistant tool and list. Read `docs/ACCESS-CONTROL.md`
before adding a route (each declares an `access.*` rule, and the coverage test
fails without one), a service that reads or writes someone's content (it takes
a principal and asks the engine), or a new shareable type. Better Auth's
endpoints that change who belongs where are closed: membership changes go
through our routes, Better Auth's adapter and the access journal.
