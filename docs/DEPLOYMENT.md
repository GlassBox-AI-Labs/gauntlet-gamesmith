# Catalog deployment

The MVP uses one Supabase project and two Vercel projects from this monorepo.
The catalog is public; publisher login and release management stay in Electron.
The separate game origin serves uploaded games, including private previews.
The multiplayer V1 extension and its rollout are documented at the end of this file.

## Infrastructure

| Service | Configuration |
| --- | --- |
| Supabase | `glassbox` organization; `glassbox-arcade`, project ref `kxvftslyclbrcmxevwbj`; Free / Nano; `us-east-1` |
| Catalog | Vercel `glassbox3` Hobby team; `glassbox-arcade` (`prj_9s1HO1s9K3qWbr1YMMHnasM5Ma0H`); root `apps/web`; Next.js; Node 22; `iad1` |
| Games | Same Hobby team; `glassbox-games` (`prj_SNLaAftPWyGfpqyjt7bEms21c00V`); root `apps/game-host`; Next.js Route Handlers; Node 22; `iad1` |
| Signup email | Resend Free; GlassBox account `glassboxailabs@gmail.com`; verified `gauntletgamesmith.com`; `us-east-1` |

The public catalog is live at **https://gauntletgamesmith.com**. The Vercel-managed
domain belongs to the GlassBox team and points to `glassbox-arcade`; game execution
uses **https://glassbox-games.vercel.app**, a separate origin. Supabase has all six
migrations through `20260907001200_inclusive_publisher_identity.sql`. Signup and the email
provider are enabled, email confirmation is required, and anonymous signup is disabled.
Custom SMTP sends confirmation codes through Resend. Both Vercel projects use production-only
server environments, outside-root workspace access, Node 22, and Virginia functions.

Initial production deployments on 2026-09-06 were built directly from GitHub commit
`cf294436600e033e62bb8d256e8d1f7c47bf564c` on `codex/game-catalog-publishing`:

| Project | Deployment | Result |
| --- | --- | --- |
| Games | `dpl_H6kmxBk3UgYjDhf4GixEP7bPoyTq` | Ready, `iad1` |
| Catalog | `dpl_BSypmAdud46mNEJVD8nrZ71iZTQu` | Ready, custom domain and HTTPS active |

The catalog was updated on 2026-09-06 to commit
`35c3c164df4bdb115caae36833fa9e79e641e8b8`, deployment
`dpl_6V7rBCtuRhpsnhkpUTM4rSSJSYWM`
(`glassbox-arcade-51tifj74f-glassbox3.vercel.app`). It is Ready in `iad1` and serves the
custom domain. This deploy includes signup, inclusive account copy, and the matching
desktop protocol. New generated public profiles use neutral names; existing profile
links are preserved.
The game deployment remains unchanged. The initial catalog deployment above is a prior
version, not the current signup-capable version.

### Shared game asset URL fix — 2026-09-07

The game host was updated to deployment `dpl_9Gf5qNEgAfaBMfgNhpocLdwLvUEY`
(`glassbox-games-lk7si12qb-glassbox3.vercel.app`) and promoted to
`glassbox-games.vercel.app`. It scopes bundled root-relative asset URLs inside
each authorized preview/public release (ADR-037). The source was a clean archive
of `65c92f5` plus the Budapest workspace's shared game-server/parser changes and
dependency lockfile; local desktop profiles, game files, and context were excluded.
This was a CLI source deployment, not a claim that the workspace changes were
already committed or merged. The catalog and database were not redeployed.

Full repository typecheck, tests, and build passed, followed by focused data tests,
typecheck, and a game-host build after the final JSON-preservation adjustment.
The full tests were rerun successfully. Browser checks loaded an actual game
through both local preview and public route layouts. Protected-deployment checks
confirmed the existing hosted game's JavaScript references its scoped asset URL
and its binary model is available before promotion. After promotion, the original
hosted preview loaded successfully in Chrome and reached its garage. Previous production deployment
`dpl_DysMihGnikgqtCcPmDYCHvMxLYmH` remains the rollback target.

Hosted read-only smoke passed again with **0 games**. The signup route now returns
405 to GET and structured JSON for invalid-domain POST requests. A temporary Auth
signup using an alias of the GlassBox inbox required confirmation and delivered the
correct verification-code email to Gmail. The test Auth user was removed; it created
no publisher profile. Provisioned publisher login previously passed through the
production API and Electron. The inclusive desktop build passed a complete local
signup → email-code verification → saved-round preview → publication → guest play →
unpublication check, with temporary test data removed. All 971 unit tests, typecheck,
build, and 17 database policy/identity assertions passed. The first real Challenger
signup and cloud publication remain for the publisher to complete in Electron.
No cloud game has been uploaded or published by deployment verification. Hosted
gameplay and large-asset streaming remain unverified until the first publication.

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

Both developer and packaged Electron apps default to the hosted catalog and game
origin. Launch the developer app normally:

```sh
pnpm dev
```

Desktop publisher sessions and pending jobs are isolated by catalog origin, so
local and hosted accounts do not overwrite one another. No Supabase server key
belongs on the desktop. Publish a saved round normally after verifying its private
preview. Do not upload export archives or manually select files from the web.
`GAUNTLET_CATALOG_URL` and `GAUNTLET_GAME_ORIGIN` remain explicit overrides for
local or staging tests. A loopback catalog defaults its game host to port 4311.

## Challenger signup and email delivery

Anyone who verifies an email at the exact domain `challenger.gauntletai.com` can
create a publisher account in Electron. The drawer offers **Create account**,
a public publisher name, email/password, and an email-code form. Verification
signs them in inside Electron. Resend and **I have a verification code** let them
resume after closing the app. No browser authentication surface is needed.

The hosted setup is complete. Platform deployment manages the infrastructure;
publishers create their own accounts and publish their own saved rounds in Electron.
For a fresh environment or sender rotation, use this order:

1. Apply the Challenger migration without resetting the hosted database.
   Apply subsequent versioned migrations, including neutral generated publisher identities.
   Regenerated `schema.sql` and types are references; the versioned migration is the input.
2. In Supabase Authentication → Email, configure a **custom SMTP sender** and a verified
   sender address. Supabase's built-in sender only sends to authorized project-team
   addresses, so it cannot serve all Challenger users. Store SMTP credentials in
   Supabase settings, never in the app, website bundle, or Git. The production sender
   and DNS setup are recorded below.
3. Copy `packages/db/supabase/templates/confirmation.html` into the **Confirm signup**
   email template. It includes `{{ .Token }}` for entry inside Electron. Keep **Confirm
   email** enabled and enable signups. Keep anonymous sign-in disabled. Preserve the
   confirmation resend/verification rate limits; tune delivery quotas for the pilot.
4. Deploy the tested feature commit to the catalog and use the matching Electron build.
   Existing game-host code does not need a change for enrollment.
5. Create an account with your own Challenger email in Electron, receive its code,
   verify, and publish a saved round. Check the private preview before promotion.

### Production Resend configuration

Resend uses the GlassBox Google account `glassboxailabs@gmail.com` and the Free plan.
The verified domain is `gauntletgamesmith.com` (domain ID
`35508f9d-8a38-4747-ab78-62f79a2e2efa`), in Northern Virginia. Sending is enabled;
receiving and tracking were not enabled. Existing website DNS records were retained.

Vercel manages these additional DNS records:

| Name | Type | Value / purpose |
| --- | --- | --- |
| `resend._domainkey` | TXT | Public DKIM key supplied by this Resend domain; copy its current value from Resend |
| `send` | MX | `feedback-smtp.us-east-1.amazonses.com`, priority 10 |
| `send` | TXT | `v=spf1 include:amazonses.com ~all` |
| `_dmarc` | TXT | `v=DMARC1; p=none;` |

Resend reports DKIM, MX, and SPF as verified. The `send` MX is for the sending
subdomain; it does not configure an inbox or replace root-domain mail routing.

Supabase Authentication → Email → SMTP settings:

| Setting | Value |
| --- | --- |
| Custom SMTP | Enabled |
| Sender address / name | `noreply@gauntletgamesmith.com` / `Gauntlet Gamesmith` |
| Host / port | `smtp.resend.com` / `465` |
| Username | `resend` |
| Password | Resend API key with **Sending access**, scoped to `gauntletgamesmith.com` |
| Per-user minimum email interval | 60 seconds |

The active key is named **Gauntlet Gamesmith Auth Production**, ID
`e23a34e2-7a53-4aed-9fce-360371b4adcd`. Its value is stored in Supabase's SMTP settings,
not this repository or desktop configuration. The temporary setup key was revoked.
Rotate by creating a replacement with the same scope, saving it in Supabase,
verifying delivery, and then revoking the old key.

The **Confirm signup** subject is **Verify your Gauntlet Gamesmith email**. The body
matches `packages/db/supabase/templates/confirmation.html` and includes `{{ .Token }}`.
Keep confirmation required; users enter the code in Electron. Supabase's custom SMTP
setup reports a default project limit of 30 emails per hour. Resend Free permits
100 transactional emails per day and 3,000 per month; both providers' limits apply.
Monitor delivery in Resend and Auth errors in Supabase before expanding the pilot.
No paid email plan or add-on was enabled.

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

## Signup troubleshooting

If Electron reports that account creation is unavailable, confirm that the catalog
has been deployed with `/api/signup`, `/api/verify-email`, and
`/api/resend-verification`. A 404 HTML response from `/api/signup` means the hosted
catalog is older than the desktop account form; it is not an invalid password.
Older desktop builds surface this as `Unexpected token '<' ... is not valid JSON`.
Deploy the catalog after completing the migration and email setup above, and use
the matching desktop build. A GET to the signup route should return 405 when the
POST-only route exists, rather than the Next.js 404 page.

## Manually provision a publisher

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
[Resend with Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp),
[Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits),
[confirmation templates](https://supabase.com/docs/guides/auth/auth-email-templates).

## Multiplayer V1 rollout

The catalog also owns `/api/multiplayer` and `/api/multiplayer/socket`. The latter
uses the [Vercel WebSocket beta](https://vercel.com/docs/functions/websockets)
with Node.js `maxDuration = 300`. Active rooms end after 180 seconds; reconnects
reuse the original deadline. No always-running game server is deployed.

An Upstash Redis Free database, **gamesmith-multiplayer**, was provisioned in
`iad1` after the operator accepted its terms. Its Vercel store is
`store_0lFJo8YQgtoo0C3I`, connected to the catalog's production environment.
Automatic upgrades and Prod Pack are disabled. The
[free plan](https://upstash.com/pricing/redis) currently includes 500K monthly
commands, 256 MB data and 10 GB bandwidth. Realtime movement consumes commands
continually; use this for limited testing and measure usage before admitting
more traffic. Do not enable an automatic paid upgrade.

Additional production environment:

| Variable | Catalog | Games |
| --- | --- | --- |
| `REDIS_URL` or `KV_URL` | Integration-provided TLS Redis credential | — |
| `MULTIPLAYER_NAMESPACE` | `gamesmith-production` | — |
| `MULTIPLAYER_API_ORIGIN` | `https://gauntletgamesmith.com` | Same |
| `MULTIPLAYER_SOCKET_URL` | `wss://gauntletgamesmith.com/api/multiplayer/socket` | Same |

`MULTIPLAYER_REDIS_URL` can explicitly override the integration URL. The game
project receives public service locations only, never Redis credentials.
`CATALOG_SECRET` signs guest room tickets and separates game/release/public and
preview scopes. Preserve it across the two project deployments. Use a distinct
secret and Redis namespace for staging. Both projects must be deployed for a
multiplayer release to preview correctly; changing environment alone does not
update an existing deployment.

Deploy the tested Git commit using the existing GlassBox-owned workflow above,
then verify two guests join a real published/private-preview multiplayer release,
exchange game-defined state, reconnect without extending the session, and close
at its original three-minute deadline. Playtest the actual shared mechanics for
the chosen genre as well as the common protocol. HTTP 426 from the socket health route only proves that
the route exists; it does not verify a working WebSocket upgrade. Record the
actual deployment IDs and runtime test results below after rollout.

### Verified rollout — 2026-09-06 (US Central)

| Surface | Git commit | Production deployment |
| --- | --- | --- |
| Catalog / guest API / WebSocket | `3c91695` | `dpl_9FokSvBZZoNz7E89s5r4hv82FHss` |
| Game host | `6032cff` | `dpl_DysMihGnikgqtCcPmDYCHvMxLYmH` |

Both deployments are Ready in `iad1`, retain the existing custom domains and
remain on Vercel Hobby. This rollout adds no Supabase schema migration; Redis
holds only temporary match data. Hosted Redis initially omitted JSON null clock
fields from a lobby response; `3c91695` normalizes those fields at the adapter
boundary and was tested against the actual TLS Redis service before redeploying.

Verification completed:

- Monorepo typecheck, 982 unit tests and all workspace builds passed. The Redis
  integration test also passed against local Redis and the hosted service using
  its own temporary namespace. Web build and multiplayer checks were rerun for
  the hosted Redis fix.
- The live 180-second protocol smoke connected two guests to different function
  instances, received 3,509 movement snapshots, forced a TCP disconnect and
  verified reconnection preserved identity and the original deadline. Both
  clients ended on that deadline. Measured RTT was 62 ms median / 74 ms p95 from
  the test machine; these measurements are not a geographic latency guarantee.
- Two real Chrome guests joined the same hosted racing room and received movement
  updates, including with the incoming-state delay preset enabled. No browser
  console errors appeared. A separate local browser session reached results at
  the three-minute deadline.
- Electron signed in to the hosted publisher account, packaged saved round 2 and
  streamed 38 shipping files (about 3 MB) into a private preview. The app remains
  at **Publish this version** for the operator. The racing release is not public.
- The read-only production catalog smoke passed for the existing Pac-Claude game,
  including guest access, origin isolation and unavailable web management routes.

The racing source integration is commit `7668738` in its separate game repository.
Its immutable saved-round revision is
`50eb5c60ed35928b2627d88fa02ab01ee77da0b8`; the private release is
`9e3d670d-6bb6-42d3-9abb-d74957995cf0`. Preview capabilities expire after 30
minutes and are intentionally absent from this document. Open a new preview
through Electron's release history when needed, then publish from the app.


### Genre-neutral SDK verification — 2026-09-07

The generalized SDK was tested against the existing hosted relay using synthetic
3D movement plus discrete activity/ready state. Two guests connected to separate
function instances, exchanged 3,424 snapshots, reconnected after a forced TCP
disconnect with the same identity, and ended at the original 180-second deadline.
`TransformBuffer` produced 3,537 presentation samples. RTT from this test machine
was 80 ms median / 96 ms p95; these observations are not a geographic guarantee.

Local verification passed 1,018 unit tests, the separate Redis integration test,
monorepo typecheck and all builds. It includes 3D/quaternion presentation,
non-spatial puzzle state and legacy pose compatibility. This was a protocol and
presentation check, not newly generated browser games in every genre. Historical
racing gameplay validation above remains one concrete example. This SDK update
did not deploy infrastructure or publish a game.

### Desktop email-code sign-in

Before distributing the desktop email-first auth flow, deploy the catalog's
`/api/sign-in-code` endpoint. In Supabase Auth, set **Email OTP Length** to **8**
and copy `packages/db/supabase/templates/magic-link.html` into the **Magic Link**
email template. The template must include `{{ .Token }}` so users receive a code
to enter in Electron. Keep the existing Confirm signup template and SMTP settings.
The local Supabase config includes both templates and the eight-digit setting.

The desktop offers password sign-in or **Email me a code**, then verifies using
the existing `/api/verify-email` endpoint. Code sign-in uses `shouldCreateUser: false`,
checks the approved email domain at both request boundaries, and requires publisher
enrollment before releasing a session. Resends use the same sign-in-code endpoint
for sign-in and `/api/resend-verification` for signup. No social login or browser
callback is involved. Hosted configuration is an explicit deployment step; editing
these local files does not change the hosted Supabase project.
