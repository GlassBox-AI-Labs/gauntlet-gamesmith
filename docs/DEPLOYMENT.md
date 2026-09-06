# Catalog deployment

The MVP uses one Supabase project and two Vercel projects from this monorepo.
The catalog is public; publisher login and release management stay in Electron.
The separate game origin serves uploaded games, including private previews.
This deployment does not change packaging UX or add multiplayer.

## Infrastructure

| Service | Configuration |
| --- | --- |
| Supabase | `glassbox` organization; `glassbox-arcade`, project ref `kxvftslyclbrcmxevwbj`; Free / Nano; `us-east-1` |
| Catalog | Vercel `glassbox3` Hobby team; `glassbox-arcade` (`prj_9s1HO1s9K3qWbr1YMMHnasM5Ma0H`); root `apps/web`; Next.js; Node 22; `iad1` |
| Games | Same Hobby team; `glassbox-games` (`prj_SNLaAftPWyGfpqyjt7bEms21c00V`); root `apps/game-host`; Next.js Route Handlers; Node 22; `iad1` |

Initial rollout is in progress. Supabase has been provisioned and the four migrations
through `20260906152854_remove_browser_auth.sql` have been applied. Public signup is
disabled, the email provider remains enabled, and a provisioned developer's password
login has been verified. Both Vercel projects have production-only server environments,
outside-root workspace access, Node 22, and Virginia functions configured. The game
project's assigned production domain is `glassbox-games.vercel.app`. GitHub connection
and the first deployments remain pending; no hosted game playback has been verified.

Deployment ownership is the GlassBox account: Vercel user `glassboxailabs-7530`, team
`glassbox3` (`team_Xdj5d9SOU4rIrCYN4lxD4hGe`). Connect its Git integration to the
GlassBox GitHub identity before deployment.
Stay on **Vercel Hobby and Supabase Free**. The public
`GlassBox-AI-Labs/gauntlet-gamesmith` repository is eligible for Hobby Git integration;
private organization repositories require a different plan. Do not change repository
visibility or upgrade plans as part of this rollout.

Keep **Include source files outside of the Root Directory** enabled in both Vercel
projects so workspace packages and the root lockfile are available. Each app's
`vercel.json` supplies the filtered frozen pnpm install, build, and region. Avoid
installing/building Electron on Vercel. The root pins pnpm 10.15.0.

## Server environment

| Variable | Catalog | Games | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Required | Required | Project HTTPS endpoint |
| `SUPABASE_ANON_KEY` | Required | — | Publishable/anon key for public reads and password authentication |
| `SUPABASE_SERVICE_ROLE_KEY` | Required | Required | Server secret/service-role key for validated privileged operations |
| `CATALOG_SECRET` | Required | Required | Same stable random 32-byte key, encoded as 64 lowercase hex characters; signs private previews |
| `GAME_ORIGIN` | Required | — | Stable HTTPS URL of the separate game project |

Store these in Vercel's server environment settings. Never prefix a server secret
with `NEXT_PUBLIC_`, put it in Git, send it to Electron, or include it in a game
artifact. Keep local administrative files outside the repo, readable only by the
operator. Environment updates require a new deployment. Keep the same signing
secret across the two projects and redeployments; rotating it expires existing
private preview URLs.

Production and preview must be configured deliberately. A Vercel preview pointed
at the production Supabase project can change production data. For the initial MVP,
use explicit production deployments from the reviewed feature checkout; do not
populate arbitrary branch preview environments with production service credentials.
When enabling Git automation after merge, use `main` for production. Shared staging
needs its own Supabase project and signing secret before it is enabled.

## Database setup and changes

1. Create a dedicated Free project in Northern Virginia. Enable the Data API and
   disable automatic exposure of new tables. The migrations explicitly grant the
   required privileges and enable RLS on private tables.
2. Save the generated database password privately. The session-pooler endpoint is
   IPv4 compatible; use SSL. For this project it is
   `aws-0-us-east-1.pooler.supabase.com:5432`, database `postgres`, user
   `postgres.kxvftslyclbrcmxevwbj`. Prefer the direct endpoint on an IPv6 network.
3. Load `CATALOG_DATABASE_URL` privately into your shell, including a percent-encoded
   password and `sslmode=require`. Inspect the target and pending migrations before
   applying them:

   ```sh
   supabase db push --workdir packages/db --db-url "$CATALOG_DATABASE_URL" --dry-run
   supabase db push --workdir packages/db --db-url "$CATALOG_DATABASE_URL"
   ```

4. Disable **Allow new users to sign up** in Authentication settings. Keep the email
   provider enabled for provisioned publisher email/password login. The website has
   no signup, callback, or account routes. Guest play needs no Supabase user.
5. The `game-artifacts` bucket remains private. Uploads use scoped signed URLs;
   only server code reads completed envelopes. Do not turn it into a public bucket.

Versioned SQL under `packages/db/supabase/migrations` is the deployment input.
`schema.sql` is the generated reference snapshot, not a substitute migration.
Develop changes against local Supabase with `pnpm db:migrate`, `pnpm db:up`,
`pnpm db:schema`, and `pnpm db:types`. Review destructive changes and take an
appropriate backup before applying them to an existing hosted database. Never use
`db reset` against the hosted project. Deployment does not copy local users, games,
or database contents into production.

## Deploy and connect Electron

Run the repository gates with Node 22:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Sign the Vercel CLI into the GlassBox AI Labs account and verify `vercel whoami`
and `vercel teams ls` before linking. A developer's default CLI account may belong
to another organization. Use a separate CLI global-config directory if needed;
do not overwrite another project's login. Never commit `.vercel/` or environment files.

Create/link the two Vercel projects from the **monorepo root**, then set their root
directories and environments as above. Deploy the game project first, set its
stable production URL as the catalog's `GAME_ORIGIN`, then deploy the catalog.
The following variables select the existing project without repeatedly relinking:

```sh
VERCEL_ORG_ID="$CATALOG_VERCEL_ORG_ID" VERCEL_PROJECT_ID="$CATALOG_GAME_PROJECT_ID" vercel --prod
VERCEL_ORG_ID="$CATALOG_VERCEL_ORG_ID" VERCEL_PROJECT_ID="$CATALOG_WEB_PROJECT_ID" vercel --prod
```

Disable Vercel Authentication **for the public production URLs** of these two
projects. Otherwise guest browsing and Electron's publishing requests hit Vercel's
login page. Keep preview deployment protection where it does not interfere with
an explicitly configured staging environment. The game project must expose only
game serving and its service identity route, never the catalog's publisher API.

Launch the developer Electron app with the catalog URL:

```sh
GAUNTLET_CATALOG_URL=https://YOUR-CATALOG.vercel.app pnpm dev
```

Desktop publisher sessions and pending jobs are isolated by catalog origin, so
local and hosted accounts do not overwrite one another. No Supabase server key
belongs on the desktop. Publish a saved round normally after verifying its private
preview. Do not upload export archives or manually select files from the web.

## Provision a publisher

Verify the person has developer/monorepo access. Load the production
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into the admin command's environment:

```sh
pnpm catalog:admin:hosted developer@example.com developer-handle Developer Name
```

The command names its target hostname, creates an email-confirmed Supabase user
and publisher profile, and writes random credentials to a private file under
`~/.gauntlet-catalog/`. It prints only that file's path. Deliver credentials through
an appropriate private channel. Do not publish them in PRs or deployment logs.
The `--hosted` path requires an explicit HTTPS endpoint and never falls back to
local Supabase. Account membership synchronization and password-reset UI remain
deferred; operators use Supabase administration.

## Verify each rollout

```sh
pnpm catalog:smoke --catalog https://YOUR-CATALOG.vercel.app --games https://YOUR-GAMES.vercel.app
```

This read-only check verifies the public catalog and database projection, guest
game access, sandbox headers, separate origins, no account cookies, rejected
unauthenticated publisher access, and absent web management/auth pages. It checks
each published game's HTML endpoint. An empty catalog is valid but does not prove
that any game has been published.

Also play the first game in a browser, including fullscreen/restart and mobile
layout. From Electron, verify sign-in, saved-round build/upload, private preview,
publish, and a release update. For server changes, use a disposable release to
verify an asset larger than 4.5 MB streams successfully through the hosted route,
and verify unpublication and expired previews deny new requests. The local
`pnpm catalog:verify` suite refuses hosted databases and cleans up its fixtures;
do not point that destructive integration runner at production.

Record deployment URLs/IDs, Git commit, region, migration version, check results,
and any caveats in the PR or release record. Screenshots remain PR attachments.

## Rollback and operations

- Use Vercel's previous successful production deployment / Instant Rollback for
  application code. Roll back both projects when a protocol change requires it.
  Keep compatible database migrations; rolling back an app does not roll back SQL.
- Use Electron's release history to preview and promote an older game release.
  This keeps the public game URL stable. Unpublish removes it from browsing and
  denies subsequent supported asset requests, but cannot recall downloaded bytes.
- The MVP uses Vercel's delivery network for the website and function routing.
  Game responses deliberately use `no-store` so every request rechecks publication
  or preview expiry. Validated immutable artifacts are cached within each warm
  process (64 MiB of encoded data, at most four simultaneous artifact loads).
  This is not a global game-asset CDN cache or a realtime multiplayer server.
- A cold game instance downloads the entire bounded artifact envelope from private
  Supabase Storage. Large/popular catalogs can consume Free-tier egress quickly;
  monitor Storage/egress and Vercel usage before increasing the pilot audience.
  Per-file delivery/CDN invalidation and automatic artifact retention are deferred.
- Watch Vercel errors and Supabase Auth/Storage/database usage. Keep both services on
  their free plans. The operator explicitly declined Vercel Pro; paid plans, add-ons,
  and extra seats require new authorization. Free Supabase projects
  may pause for inactivity; restore through Supabase before diagnosing app errors.
- Keep a separate database backup procedure and private artifact backups before
  relying on this pilot for irreplaceable content. Free-tier backup guarantees are
  not equivalent to a paid production recovery plan.

References: [Vercel monorepos](https://vercel.com/docs/monorepos),
[Git deployment plan restrictions](https://vercel.com/docs/git),
[function payloads and streaming](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions),
[Supabase private downloads](https://supabase.com/docs/guides/storage/serving/downloads).
