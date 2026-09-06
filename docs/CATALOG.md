# Local game catalog

The v1 catalog runs in this monorepo. A Glassbox developer can publish a saved
round and another device on the same trusted LAN can play it without an account.
Multiplayer, persistent player saves, cloud hosting, and payments are not part of v1.

## Start

Prerequisites: Node 22, pnpm, Docker Desktop running, and the Supabase CLI. From
the repository root:

```sh
pnpm install
pnpm catalog:up
```

This starts local Supabase, restricts its published ports to loopback, builds the
web app, and starts the catalog at `http://localhost:4310` and the game-content
host on port `4311`. Both app ports bind to `0.0.0.0` for LAN access. On another
device, replace `localhost` with the host machine's LAN IP. Use the same hostname
consistently when signing in. If macOS asks whether Node may accept incoming
connections, allow it for your intended local network.

The setup script adjusts only containers labelled for this Supabase project. It
retains their volumes and leaves other Docker projects alone. If recreation fails,
it restores the stopped container. It does not change Docker daemon defaults.
Use `pnpm catalog:db` rather than raw `supabase start` to maintain loopback bindings.
Local Supabase has development keys and is not a production deployment. This v1
uses HTTP on a trusted developer LAN; do not expose it to the internet.

For frontend development, run `pnpm catalog:db` followed by `pnpm catalog:dev`.
`pnpm dev` still starts the desktop. Stop catalog servers with Ctrl-C; local data
survives. `supabase stop --project-id gauntlet-gamesmith` stops the backend and
retains its local volumes. Do not reset the database to apply ordinary updates.
New migrations can be applied with `supabase migration up --local`.

## Provision publishers

Only provision developers whose monorepo access you have verified. Signup is
closed; merely having a repository copy does not establish membership.

```sh
pnpm catalog:admin you@example.com your-handle Your Name
```

The command creates the Auth user and publisher profile and writes a randomly
generated password to a private file in `~/.gauntlet-catalog/`. The command prints
the file path, not its contents. Open that file locally to sign in. Never commit
or share it. Login emails are not exposed in public publisher profiles. Repository
membership synchronization and password-reset UI are deferred; administrators can
manage these test accounts through the local Supabase Auth admin interface.

## Publish from the desktop

1. Open a run and select a completed round with a saved revision.
2. Click **Publish**, then **Sign in to publish**. Sign in in the system browser
   and approve the displayed connection code only for the desktop request you made.
3. Enter a title, URL slug, description, controls, and optional raster cover path.
   The cover must be inside the selected shipping output. The default output
   folder is `dist`; you can choose another relative folder.
4. **Build & open private preview** builds the immutable saved round and uploads
   only its shipping files. Vite builds receive `--base=./` for relative asset URLs.
   The build uses installed dependencies, not an automatic dependency install.
5. Play the preview. **Publish this version** explicitly promotes that exact build.
   Publishing an update to the same run/account keeps the game ID and URL slug.

The publishing session is encrypted by Electron's OS-backed storage and is never
sent to the renderer or game code. Browser approval transfers that session to the
desktop; sign in separately if you also want a browser studio session. Local game
development does not require this account. Override the catalog endpoint when
launching the desktop with `GAUNTLET_CATALOG_URL=http://HOST:4310`.

Build commands, output, upload progress, and outcomes appear in the run log.
Checkouts and full build streams are retained under the run's app-owned metadata
directory. A build has a two-minute timeout and uses the existing exact-identity
SIGINT process supervisor. The app prevents quitting during an active publishing
operation. An interrupted build is settled before retry; incomplete launch
ownership fails closed and requires inspection of its retained local job record.
Upload retry identities survive app restart. Private preview links expire after
30 minutes and are invalidated by a catalog-server restart; recreate the preview
from the studio. They are capabilities: do not share one as a public game URL.

## Import an existing build

```sh
pnpm catalog:import /absolute/path/to/dist /absolute/path/to/game-artifact.json
```

Sign in at `/dashboard`, choose the artifact, fill in the listing, and upload.
The import command never overwrites an existing output artifact. The build must
use relative asset URLs; for Vite use `vite build --base=./`. It does not execute
scripts in the supplied folder. A failed upload can be retried with the same
form contents without creating duplicate releases.

The studio lists each publisher's games and release history. Preview any ready
release before promoting it, including a rollback. **Unpublish** removes it from
the grid and denies the supported public asset URLs. Already downloaded bytes
cannot be recalled. Drafts and superseded artifacts remain stored in v1; there
is no automatic retention/deletion job.

## Supported game builds

- Static browser games with `index.html`, relative asset references, and installed
  build dependencies. No custom backend or server-side functions.
- At most 1,500 files and 24 MiB decoded shipping data (35 MiB upload envelope).
- No links, hidden/private directories, reference/critique folders, source maps,
  source TypeScript, or unsupported file types. The receiver verifies hashes too.
- Covers are PNG, JPEG, WebP, or GIF and must be included in the artifact.
- Game frames have opaque sandbox origins: no platform credentials, persistent
  browser storage, external network fetches, forms, or top-level navigation.
  Bundle required assets locally. The game host serves static resources with
  CORS for module loading. Networked games require the later multiplayer module.

Publish only shipping assets you have permission to share. The existing Export
feature is deliberately separate: it includes project history, raw streams, and
reference evidence which must never become a game upload.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm catalog:verify
```

The first three commands cover all workspace packages. The last requires the
local catalog to be running and exercises real local Supabase Auth, ownership,
private previews, checksum rejection, retries, concurrent-state protection,
updates, rollback, unpublish, device sign-in, and denial of direct database access.
It provisions temporary test publishers and removes their data afterward. It
refuses a non-local Supabase endpoint. Ordinary unit tests use fixtures and never
touch harness accounts.

## Architecture

`packages/publishing` holds the browser-safe wire contract and a separate Node
artifact packer. `apps/web/server/catalog.ts` owns upload and promotion behavior;
Postgres transactions guard release identity and generation. Supabase Storage
holds immutable artifact envelopes, while the separate game host serves their
HTML correctly. A bounded in-memory cache avoids retrieving an entire artifact
for each asset; authorization is rechecked even for cached public files.

The browser uses tab-scoped session storage for its own publisher session and
Authorization headers; no account cookies are sent to the game-content port.
Game code cannot access the account origin. Supabase tables have RLS enabled and
deny direct anon/authenticated access; only the validated publishing backend
performs mutations. All hosted deployment credentials remain a future concern.
