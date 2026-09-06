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

The public catalog is live at **https://gauntletgamesmith.com**. The Vercel-managed
domain belongs to the GlassBox team and points to `glassbox-arcade`; game execution
uses **https://glassbox-games.vercel.app**, a separate origin. Supabase has all four
migrations through `20260906152854_remove_browser_auth.sql`. Public signup is disabled
and the email provider remains enabled. Both Vercel projects use production-only
server environments, outside-root workspace access, Node 22, and Virginia functions.

Initial production deployments on 2026-09-06 were built directly from GitHub commit
`cf294436600e033e62bb8d256e8d1f7c47bf564c` on `codex/game-catalog-publishing`:

| Project | Deployment | Result |
| --- | --- | --- |
| Games | `dpl_H6kmxBk3UgYjDhf4GixEP7bPoyTq` | Ready, `iad1` |
| Catalog | `dpl_BSypmAdud46mNEJVD8nrZ71iZTQu` | Ready, custom domain and HTTPS active |

The initial hosted read-only smoke passed with an empty catalog, and the provisioned
developer signed in through the production API and Electron. No game was uploaded
or published during that check; hosted gameplay and large-asset streaming are still
unverified. The operator took over deployment after this point. The Challenger signup
change below is tested locally and **has not been applied to hosted Supabase or Vercel**.

Deployment ownership is the GlassBox account: Vercel user `glassboxailabs-7530`, team
`glassbox3` (`team_Xdj5d9SOU4rIrCYN4lxD4hGe`). Its connected GitHub identity is
`glassboxailabs`, with repository Maintain access. The deployment records name this
Vercel creator and the original GitHub source commit; commit authors are preserved.
Stay on **Vercel Hobby and Supabase Free**. The public
`GlassBox-AI-Labs/gauntlet-gamesmith` repository is eligible for Hobby Git integration;
private organization repositories require a different plan. Do not change repository
visibility or upgrade plans as part of this rollout.
Hobby permits personal, noncommercial use; free repository collaboration does not
override that usage restriction. Individual game publishers need only their platform
account in Electron, never a Vercel account or paid seat.

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

4. For Challenger enrollment, apply `20260906225000_challenger_publishers.sql`, then
   enable **Allow new users to sign up** and the email provider. Keep **Confirm email**
   enabled. Configure email delivery and the confirmation template as described below
   before exposing signup. The website has no signup, callback, or account pages.
   Guest play needs no Supabase user.
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

Create the two Vercel projects from the **monorepo root**, then set their root
directories and environments as above. Deploy the game project first, set its stable
production URL as the catalog's `GAME_ORIGIN`, then deploy the catalog. The initial
rollout used explicit Git-source deployments through Vercel's API. Save this request
to a local JSON file, substituting the selected project and the tested, pushed commit:

```json
{
  "name": "glassbox-games",
  "project": "prj_SNLaAftPWyGfpqyjt7bEms21c00V",
  "target": "production",
  "gitSource": {
    "type": "github",
    "org": "GlassBox-AI-Labs",
    "repo": "gauntlet-gamesmith",
    "ref": "codex/game-catalog-publishing",
    "sha": "TESTED_PUSHED_COMMIT"
  }
}
```

```sh
vercel api /v13/deployments -X POST --input "$CATALOG_DEPLOY_REQUEST" \
  --scope glassbox3 --global-config "$CATALOG_VERCEL_CONFIG" --raw
vercel inspect "$CATALOG_DEPLOYMENT_URL" \
  --scope glassbox3 --global-config "$CATALOG_VERCEL_CONFIG"
```

Repeat with the catalog name/project ID. Verify `Ready`, source SHA, creator, aliases,
and function region before testing the stable domain. The initial CLI global-config
directory is `~/.gauntlet-catalog/hosted/vercel-cli`; keep it private. API responses may
contain environment metadata and must not be copied wholesale into PRs.

Automatic deploy-on-push is **not enabled**. `vercel git connect` additionally needs
the Vercel GitHub application installed for the organization; the connected account
can request but cannot approve that organization installation. Explicit Git-source
deployments work without that project link and were used for this rollout. Enable
automatic deployment only after an organization owner installs the application for
this repository and the feature is merged; use `main` for production then. Do not
rewrite commits or impersonate the hosting account to satisfy an author check.

The custom domain was attached with `vercel domains add gauntletgamesmith.com
glassbox-arcade` under the same scope/config. Vercel manages its DNS and certificate.
Retain `GAME_ORIGIN=https://glassbox-games.vercel.app` when changing the catalog domain.

Disable Vercel Authentication **for the public production URLs** of these two
projects. Otherwise guest browsing and Electron's publishing requests hit Vercel's
login page. Keep preview deployment protection where it does not interfere with
an explicitly configured staging environment. The game project must expose only
game serving and its service identity route, never the catalog's publisher API.

Launch the developer Electron app with the catalog URL:

```sh
GAUNTLET_CATALOG_URL=https://gauntletgamesmith.com \
GAUNTLET_GAME_ORIGIN=https://glassbox-games.vercel.app pnpm dev
```

Desktop publisher sessions and pending jobs are isolated by catalog origin, so
local and hosted accounts do not overwrite one another. No Supabase server key
belongs on the desktop. Publish a saved round normally after verifying its private
preview. Do not upload export archives or manually select files from the web.

## Challenger signup and email delivery

Anyone who verifies an email at the exact domain `challenger.gauntletai.com` can
create a publisher account in Electron. The drawer offers **Create a Challenger
account**, a public publisher name, email/password, and an email-code form. Verification
signs them in inside Electron. Resend and **I have a verification code** let them
resume after closing the app. No browser authentication surface is needed.

Deploy this change yourself in this order:

1. Apply the pending Challenger migration without resetting the hosted database.
   Regenerated `schema.sql` and types are references; the versioned migration is the input.
2. In Supabase Authentication → Email, configure a **custom SMTP sender** and a verified
   sender address. Supabase's built-in sender only sends to authorized project-team
   addresses, so it cannot serve all Challenger users. Store SMTP credentials in
   Supabase settings, never in the app, website bundle, or Git. Choose the sender/provider
   and its quota as part of your deployment; no email service has been provisioned here.
3. Copy `packages/db/supabase/templates/confirmation.html` into the **Confirm signup**
   email template. It includes `{{ .Token }}` for entry inside Electron. Keep **Confirm
   email** enabled and enable signups. Keep anonymous sign-in disabled. Preserve the
   confirmation resend/verification rate limits; tune delivery quotas for the pilot.
4. Deploy the tested feature commit to the catalog and use the matching Electron build.
   Existing game-host code does not need a change for enrollment.
5. Create an account with your own Challenger email in Electron, receive its code,
   verify, and publish a saved round. Check the private preview before promotion.

The privileged `publisher_for_user` RPC reads the current confirmed Auth email and
enrolls eligible users atomically. It matches the domain exactly, ignores client claims
of eligibility, and rechecks domain membership for every authenticated publishing
request. New users get a stable generated publisher handle; their public name comes
from signup. Parent domains, subdomains, and suffix lookalikes do not qualify. An admin
can set `publishers.enabled=false`; signing in never re-enables that row. Existing
manually provisioned accounts keep their explicit access. Changing an automatically
enrolled account to an outside email removes its publishing access, without deleting
its historical releases.

For local testing, `pnpm catalog:db` uses the committed signup/confirmation settings
and the confirmation template. After changing Supabase config, stop this project's
local containers normally (preserving data), then run `pnpm catalog:db` to restart
them with loopback-only bindings. Verification emails appear at
`http://127.0.0.1:56324`. Run `pnpm db:test`, `pnpm catalog:verify:accounts`, and
`pnpm catalog:verify` against the local catalog. The account verifier refuses hosted
targets, tests email delivery/code exchange, and removes its temporary Auth/publisher
records. It does not use real Challenger mailboxes.

## Manually provision a publisher

If Electron reports that account creation is unavailable, confirm that the catalog
has been deployed with `/api/signup`, `/api/verify-email`, and
`/api/resend-verification`. A 404 HTML response from `/api/signup` means the hosted
catalog is older than the desktop account form; it is not an invalid password.
Older desktop builds surface this as `Unexpected token '<' ... is not valid JSON`.
Deploy the catalog after completing the migration and email setup above, and use
the matching desktop build. A GET to the signup route should return 405 when the
POST-only route exists, rather than the Next.js 404 page.

For an explicit developer exception outside the enrollment domain, verify monorepo
access and load the production
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into the admin command's environment:

```sh
pnpm catalog:admin:hosted developer@example.com developer-handle Developer Name
```

This administrative exception bypasses self-service email verification. The command
names its target hostname, creates an email-confirmed Supabase user
and publisher profile, and writes random credentials to a private file under
`~/.gauntlet-catalog/`. It prints only that file's path. Deliver credentials through
an appropriate private channel. Do not publish them in PRs or deployment logs.
The `--hosted` path requires an explicit HTTPS endpoint and never falls back to
local Supabase. Account membership synchronization and password-reset UI remain
deferred; operators use Supabase administration.

## Verify each rollout

```sh
pnpm catalog:smoke --catalog https://gauntletgamesmith.com --games https://glassbox-games.vercel.app
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
[Supabase private downloads](https://supabase.com/docs/guides/storage/serving/downloads),
[Supabase SMTP requirements](https://supabase.com/docs/guides/auth/auth-smtp),
[confirmation templates](https://supabase.com/docs/guides/auth/auth-email-templates).
