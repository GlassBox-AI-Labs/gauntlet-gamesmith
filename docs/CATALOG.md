# Local game catalog

The website is for browsing and playing games. Publishing and release management
belong to Electron. There is no browser dashboard, artifact picker, or import API.
A publisher account is required only for publication; ordinary local development
and guest play remain account-free. Multiplayer and persistent player state are deferred.

## Start

Use Node 22, pnpm, Docker Desktop, and the Supabase CLI:

```sh
pnpm install
pnpm catalog:up
```

This starts local Supabase, builds Next.js, and starts the website on port 4310
and the separate game-content host on 4311. Both app ports bind to `0.0.0.0`;
other trusted LAN devices can browse/play using the host machine's LAN address.
The launcher preserves local data and its signing secret in ignored `.catalog/`.
Ctrl-C stops the app servers. `supabase stop --project-id gauntlet-gamesmith`
stops the database containers while retaining their volumes.

`pnpm catalog:db` restricts Supabase's published ports to loopback. It changes only
containers labelled for this project, preserves their volumes, and restores the
stopped container if recreation fails. Use this command instead of raw Supabase
startup. V1 publisher Electron runs on this same machine; remote LAN desktop
publishing is not supported by the loopback Storage endpoint. Local HTTP is for
trusted development networks, not an internet deployment.

For development, start `pnpm catalog:db`, then `pnpm catalog:dev`. `pnpm dev` starts
the desktop independently. Apply new migrations with `pnpm db:up`; do not reset
the database for an ordinary update.

## Publisher accounts

An administrator verifies monorepo access and provisions a local publisher:

```sh
pnpm catalog:admin you@example.com your-handle Your Name
```

The command creates a Supabase Auth identity and publisher profile, then writes
a random password to a private file in `~/.gauntlet-catalog/`. Only the file path
is printed. These credentials are separate from harness authentication and must
never be committed. Signup is closed. Membership synchronization and password
reset UI are deferred; local admins use Supabase Auth administration.

## Desktop workflow

1. Open a run and click **Publish round N** for its latest completed saved round,
   or select a specific completed round and click **Publish**.
2. Enter your developer email and password directly in the publishing drawer and
   click **Sign in to publish**. Supabase authenticates the account without opening
   a browser. The password is cleared after each attempt and is never saved.
3. Enter listing metadata and the relative shipping-output directory (default
   `dist`). An optional cover path must identify a raster image in that output.
4. **Build & open private preview** builds the selected immutable saved revision
   with its installed dependencies. Vite receives `--base=./`. Only validated
   shipping files are uploaded, directly to a scoped Supabase Storage URL.
5. Play the private preview and explicitly **Publish this version**.
6. In the same drawer, **Releases** lists that run's game history. Preview an
   older ready release before rolling back. **Unpublish** asks for confirmation
   in a native dialog. **Sign out** clears the desktop publisher session.

Updates preserve the game ID and slug. Failed builds/uploads leave the published
release intact. Promotion and unpublication reject stale generation values.
Unpublishing removes the game and denies supported public asset URLs, but cannot
recall bytes already downloaded. V1 retains drafts, superseded releases, and
pending upload objects; automatic storage retention is deferred.

The local publication job records run, round, saved revision, request identity,
and progress. Build output and failures appear in the run log. Builds use a
two-minute timeout and the existing exact-process-identity SIGINT supervisor.
The app blocks quitting during an active publishing operation. Incomplete launch
ownership fails closed for inspection; safe upload retry survives restart.

Electron main stores the publisher session using OS-backed encryption; tokens
never reach the renderer, agents, game build, or export.
Email/password credentials cross the validated preload bridge once to main,
which calls the catalog's small Supabase password-grant endpoint. Authentication
requires HTTPS or a loopback catalog. The API sets no browser cookies; only tokens
are encrypted on disk. The website has no account UI or auth middleware.
Private previews last 30 minutes and survive server restart with the same
`CATALOG_SECRET`. Treat their URLs as capabilities, not public links.

## Boundaries and supported builds

- Static browser games with `index.html`, relative assets, and installed build
  dependencies. No custom backend, networking, or persistent player saves.
- Maximum 1,500 files and 24 MiB decoded shipping data (35 MiB envelope).
- No links, hidden/private directories, reference/critique folders, source maps,
  source TypeScript, or unsupported types. The server verifies hashes, source
  revision, listing, and cover before marking a release ready.
- PNG, JPEG, WebP, and GIF covers are part of the shipping artifact.
- Games use an opaque sandbox origin: no account credentials, persistent browser
  storage, external fetches, forms, or top-level navigation. Bundle assets locally.

Export is a separate developer archive with history and reference evidence; it
must never be uploaded as a release. Publish only assets you may share. The saved
round provenance is an integrity contract, not remote attestation of a publisher's
machine; v1 deliberately trusts allowlisted developers.

## Architecture and conventions

`apps/web` uses Next.js App Router. Server Components read domain functions
rather than their own HTTP endpoints.
There are no browser account forms or Server Actions in this browse-only
site. Thin authenticated Route Handlers implement the Electron protocol, including
Supabase email/password login. Release mutation endpoints require a publisher
bearer token and accept no cookie authentication.


`packages/data` owns validated domain operations with an injected typed Supabase
client. Postgres RPCs own multi-table transactions and generation checks. Public
reads use a narrow catalog projection; RLS denies direct access to private tables.
`packages/db/supabase/schema.sql` and generated `packages/db/types/supabase.ts`
are the authoritative schema snapshot and client types. Change the database with
an idempotent versioned migration, then regenerate both:

```sh
pnpm db:migrate descriptive_name
pnpm db:up
pnpm db:schema
pnpm db:types
```

`packages/ui` owns shared renderer/web buttons, badges, inputs, sheets, brand
markup, and theme tokens. Renderer compatibility exports preserve existing app
imports. Shared UI has no Electron, Node, or Next dependency.
`packages/publishing` owns the wire contract and Node artifact packer.

The separate local game host serves validated artifact files with strict headers,
a bounded cache, and a fresh publication check on every public request. The
Next.js function receives small metadata requests; large envelopes bypass its
request body limit through scoped Storage upload URLs.

## Hosting boundary

V1 is local. The website is a standard Next.js project with Vercel root
`apps/web`, workspace install, and `next build`. Hosted runtime configuration
requires `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, a stable
64-character hex `CATALOG_SECRET` and `GAME_ORIGIN` on a separate
HTTPS domain. Service credentials are server-only. A hosted game-content/CDN
adapter and deployment configuration remain required before a cloud launch;
the local Node game host is not a Vercel Function. No cloud resources are deployed.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm catalog:verify
```

The integration check requires the running local service. It provisions temporary
publishers and cleans up their data. It exercises real Auth, ownership, saved-round
uploads, validation/retry, preview, promotion, rollback, unpublish, native email/password sign-in, and private-table denial. It refuses a non-local Supabase
endpoint. Screenshots are PR attachments, not repository assets.
