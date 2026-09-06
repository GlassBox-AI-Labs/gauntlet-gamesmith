# Game catalog and publishing

Status: design record, 2026-09-05. Local v1 is implemented; see
[CATALOG.md](CATALOG.md) for current setup and supported behavior. The v1
clarification below is authoritative; later sections retain the longer-term
hosted and multiplayer proposals.

## V1 scope clarification — 2026-09-05

This section supersedes conflicting sequencing and defaults in the exploratory
design below. The later sections describe the longer-term architecture.

**First phase:** catalog, publisher accounts, and desktop publication running on
the local network using local Supabase. Pick any working existing Pac-Man
implementation after locating and smoke-testing it. Multiplayer comes later;
there is no requirement to create a multiplayer game for v1.

Ship the grid, game/player page, publisher profile, and publication from a saved
round. The chosen flow is build/validate → sign in if needed → title/description/
cover → private preview → explicit Publish. Promote exactly the previewed artifact.
Updates retain the game URL; include rollback and unpublish. If Pac-Man is not a
registered run, a developer import command can submit its static build through
the same artifact pipeline. External-URL registration is deferred.

All implementation belongs in this monorepo: `apps/web`, shared publication
contracts when needed, `supabase/`, and the existing desktop app. Add the shared
multiplayer package in its later phase, not as a speculative v1 scaffold.

Publisher eligibility is monorepo access. For local v1, an administrator provisions
an allowlist of known Glassbox developers, with closed signup and local
email/password authentication. Do not infer membership from a repository copy
or client-supplied URL. Automated repository membership verification can follow
with hosted onboarding. Never commit usable account passwords. Local development
remains account-free; harness authentication is separate.

V1 does not support persistent player progress, saves, high scores, or resumable
matches. Catalog ownership, artifacts, and publication records are durable.
Per-game player schemas are deferred; logical schema isolation remains a proposal
to confirm when persistent game data is introduced.

Run the catalog, publication backend, game-content host, and local Supabase on
one developer machine. Other LAN devices browse/play through reachable LAN URLs.
Use a separate origin for game code and protect private previews with actual
authorization. Different ports separate origins but do not isolate cookies;
ensure account credentials never reach the game host. Never expose service-role
keys to browsers. Check redirects and assets from a second physical device.
Keep database/admin services restricted. Document container-runtime setup for
local Supabase without requiring it for ordinary single-player development.

**Later hosted phase:** US first, Vercel/CDN plus one shared production Supabase
project. Budget target is Supabase Free and the user's approximately $20/month
Vercel budget, subject to checking actual quotas and usage charges before launch.
No cloud setup is required for v1. Shared hosted staging is for later outside
developers; Glassbox v1 uses local Supabase. Upgrades and geographic routing are
deferred platform decisions.

**Later multiplayer phase:** no player signup required. Use one unified guest
room/session process behind the shared module. Authority is game-dependent;
host-client simulation is a candidate, not an accepted universal default. Select
the first multiplayer game before choosing its authority and disconnect policy.
Server-authoritative games require a shared runtime extension; Supabase messaging
alone does not run their simulation. No monetization or persistent player data.

V1 acceptance: a developer publishes the selected Pac-Man; another LAN device
plays without login; another account cannot edit it; failed updates preserve the
playable release; rollback, unpublish, and restart recovery work. Publication
excludes workspace history/reference material and isolates publisher credentials
from game code. Run required typecheck/tests and relevant builds.

No further product answers are required to start this phase. Locating the game
and verifying local runtime/container dependencies are implementation work.

## Product boundary

The catalog, publishing backend, multiplayer module, and infrastructure migrations
belong in this monorepo alongside the Electron app. Proposed layout:
`apps/web` for the catalog, trusted player, and publishing endpoints;
`packages/multiplayer` for the shared browser-compatible multiplayer module;
`supabase` for versioned platform/game provisioning migrations, local configuration,
and test seeds. Introduce a small shared publishing contract package when both
desktop and web consume it; neither app imports the other app's internals. This
is a proposed layout, not a scaffold already present in the repository.

Developers use the desktop app and their own harness logins to make games locally.
A Gauntlet account is required only to publish or manage published games. Browsing
the catalog and playing a single-player game require no account.

The first audience is our developers. Use the same publisher-account and ownership
model that will later support public signup, with a server-enforced publisher
allowlist during the developer pilot. Creators never need a Vercel or Supabase account.

The website and browser game builds are hosted on Vercel and delivered through its
CDN. One shared managed production Supabase project owns platform authentication, Postgres
catalog and game data, Storage, and Realtime for all games. This is a shared
platform service, not a new backend deployment for each game. Local runs and
their complete event histories remain in SQLite. Vertical scaling is acceptable
as usage grows; no per-game infrastructure choice is delegated to creators.

Launch for US players with a single US deployment region for the shared backend.
Choose the exact region during provisioning and benchmark US cross-country play.
Geographic room routing is deferred and remains platform-owned when introduced.
Recommend a separate shared staging Supabase project in the same US region; all
staging games share it. Environment isolation does not create per-game servers.

The initial multiplayer scope is casual, low-stakes play. Creator monetization,
payments, paid game access, prizes, and payouts are out of scope. Platform
monetization is deferred.

This introduces a publishing-specific exception to ADR-003's removal of app auth
and Supabase. Record that exception in an accepted ADR when implementing this
proposal; it does not restore remote loop coordination or require a cloud login
to develop locally.

## First experience

The initial catalog can register an already-hosted game such as Pac-Man: save its
title, cover, description, publisher owner, and existing public play URL. This
does not require rebuilding or redeploying it. Verify that URL is publicly
playable; local Play alone does not establish public hosting. Link directly to
the existing game initially; embed only if its host permits framing and the
player isolation requirements are met. Platform-managed deployment is a later
publishing capability, not a prerequisite for this catalog.

1. A visitor sees a responsive grid: cover, title, publisher, and a short description.
2. A game page provides its description, controls, supported devices, publisher link,
   and Play button. Loading, failed loading, and unavailable releases have explicit states.
3. A publisher profile lists that publisher's public games.
4. A developer chooses Publish for a saved round, signs in if needed, and reviews
   the title, description, cover, and exact release preview.
5. Publish creates a release and returns a permanent game-page URL. Progress and
   failures appear in the desktop event log.
6. Publishing another version updates the same game. The owner can roll back to a
   previous ready release or unpublish the game.

Suggested routes: `/`, `/games/[slug]`, `/publishers/[handle]`, and `/dashboard`.
Begin with static browser-playable builds. A game requiring an unsupported backend
receives an actionable compatibility result rather than an apparently successful release.

## Hosting and execution

Keep the catalog/account application separate from executable game content. Serve
games on separate origins, isolated per game, without account cookies. Embed them
in a sandboxed player with only the capabilities required for play, and provide a
fullscreen control. Never send a publisher session into a game frame.

For the small pilot, use a platform-owned Vercel project per game and immutable
deployments per release. The catalog application has its own project. Provider
project-count, file-size, deployment-rate, bandwidth, and retention limits must be
checked against the selected plan before launch; revisit the project-per-game
arrangement before broad public signup.

Those projects serve static files only; they do not imply per-game servers,
Supabase projects, or authentication systems. All platform multiplayer traffic
uses the shared Supabase project.

Upload a validated static build, not arbitrary source for a cloud build. The
platform constructs deployment configuration and never accepts publisher-supplied
functions, routing configuration, or build commands for remote execution.
Supabase Storage can stage the artifact, but is not the playable HTML origin:
its documented storage behavior returns HTML as plain text.

Vercel deployment credentials and Supabase privileged keys belong only to the
publishing service. Large artifacts upload directly to scoped staging storage,
not through an application request body. A durable publication job records the
deployment ID and reconciles provider state after retries or restarts.

## Release pipeline

Build from an immutable local snapshot through the app's trusted execution path.
The first version can require a completed saved round. Do not reuse Export: it
copies source, Git data, reference material, run history, and raw CLI streams.

Create a versioned release manifest with the entrypoint, file hashes and sizes,
source revision, runtime requirements, and artifact digest. Validate file counts,
total bytes, relative paths, links, and allowed content. Include only the selected
shipping output; exclude local metadata, credentials, source maps by default,
and reference-study evidence. Check asset provenance: reference evidence must not
become shipping art (PHASE-001). Build success alone does not establish publishability.

The server derives publisher ownership from the authenticated session, validates
the uploaded artifact independently, and enforces quotas. It never trusts an owner
ID, output-path assertion, or compatibility verdict supplied by the client.

Persist `queued → validating → deploying → ready` with explicit failure states.
Use idempotency keys for retries. Preview the exact immutable deployment before
promotion. Only a ready release belonging to the game can become its public
release; switch the pointer transactionally and invalidate catalog caches.
Concurrent publication attempts must not let an older request replace a newer one.
A failed upload or deployment leaves the previous public release available.

Unpublish removes the catalog listing and disables the supported play route.
Direct deployment access must also be disabled or removed through the provider;
otherwise unlisting alone leaves old URLs playable. Already downloaded public
assets cannot be recalled. Specify retention and deletion behavior before launch.

## Accounts and data

There is one platform account identity across the catalog, publishing, and future
gamer login. Publisher is a role/profile on that identity, not another login.
Players sign in once on the platform and can enter any supported game without
creating another account. Guest play remains possible where the game permits it.
Generated game code must not receive the platform's reusable account token:
the trusted platform player owns the session and brokers narrowly scoped game
operations. Validate frame origin, game identity, room membership, message shape,
and rate limits. Private Realtime channel authorization independently enforces
membership; naming a channel with a game ID alone does not isolate it.

Interpret "each game its own DB" as **a dedicated Postgres schema per game inside
the shared project**, subject to confirming that logical isolation meets the
desired requirement. Supabase provides a Postgres database per project; a schema
is a namespace with separately controlled tables, not a physically separate
database. Separate physical databases would require a different design.

Platform tables hold identities, publishers, catalog entries, rooms, and room
membership. A platform-assigned schema such as `game_<internal_id>` holds a game's
durable saves and game-specific state. Provision schemas and migrations through
platform-controlled operations. Do not grant generated code DDL, arbitrary SQL,
or privileged database credentials. Schemas require grants and row-level policies;
schema separation alone is not an authorization boundary. Access through bounded
platform operations, with no general cross-schema API for games. Shared project
resources and backups are a deliberate tradeoff: a busy game can affect others,
so impose per-game limits and monitor usage.

| Record | Responsibility |
| --- | --- |
| Auth user | Private login identity, managed by Supabase Auth |
| Publisher | Public handle, display name, avatar; one owner in v1 |
| Game | Publisher owner, stable ID and slug, metadata, visibility, current release |
| Release | Immutable artifact digest, manifest, deployment reference, readiness |
| Publication job | Request identity, release, progress, errors, retry/reconciliation state |

For existing hosted games, v1 can use an explicitly external hosting mode with a
validated HTTPS play URL instead of a platform release. Do not imply that the
platform owns deployment, rollback, or availability for those entries. Limit
registration to our authenticated developers during the pilot. Unpublishing an
external entry removes its listing; it cannot revoke the externally hosted game.

Use database constraints to ensure the current release belongs to the same game.
Row-level security restricts publisher mutations to the owner; public reads expose
only published metadata. Readiness and promotion are service-controlled operations.
Storage permissions follow the same ownership rules. Keep login email private.

Desktop authentication opens the system browser and returns through a verified,
one-time authorization flow bound to the initiating app instance. Store publishing
sessions in OS-protected storage in main, separately from CLI authentication.
Never place those tokens in a game workspace, agent environment, renderer, log,
or portable export. Signing out of publishing does not interrupt local loops.

## Multiplayer direction

Identify runtime requirements before implementation, then verify the built game
against them before publishing. A late classifier cannot reliably convert an
arbitrary custom server into a supported platform game.

Build one platform multiplayer SDK and protocol on Supabase Realtime Broadcast
and Presence. Every generated multiplayer game uses that SDK. The loop selects a
supported gameplay mode and settings; it does not select a provider or invent a
custom networking stack. Networking improvements then apply across games through
compatible shared SDK releases. Pin the SDK/protocol version per game release;
upgrade and revalidate existing releases rather than silently changing their code.

| Requirement | Shared platform treatment |
| --- | --- |
| Local or single-player | Static browser build; no multiplayer allocation |
| Asynchronous or turn-based | Platform-validated moves and durable Postgres state |
| Lobby and room membership | Shared room service plus private Realtime channels and Presence |
| Casual continuous play | Host-client simulation, Broadcast inputs/snapshots, shared smoothing and reconnect protocol |
| Continuous server-authoritative simulation | Unsupported initially; requires a platform-wide runtime extension |

The proposed casual-play default is a host client that runs game simulation and
sends periodic snapshots. Other clients send inputs and interpolate snapshots;
prediction/reconciliation is available for game modes that support it. Host
authority is not cheat resistance. Use no trusted competitive rankings, financial
outcomes, or client-authorized privileges. For v1, a host disconnect pauses the
room and permits a bounded reconnect; if the host does not return, end the room
clearly. Implement host migration once in the SDK if later needed.

Keep movement and frequent inputs on Broadcast. Do not write every frame to
Postgres or route moment-to-moment movement through Vercel request handlers.
Postgres stores durable state and occasional checkpoints. The shared SDK owns
sequence numbers, stale/duplicate handling, snapshot recovery, clock estimation,
interpolation buffers, bounded payloads, send rates, timeouts, and reconnects.
Broadcast is transport, not durable state or an authoritative simulation engine.

Supabase's managed Realtime service uses a cluster; one project is not literally
one machine. Database compute upgrades do not automatically increase every
Realtime quota or eliminate geographic latency. Scale database compute and
Realtime capacity according to their measured bottlenecks. Keep one shared
project as requested, and set explicit per-game room/player/message limits so a
single game cannot consume its entire capacity.

Validate the shared networking layer with a reusable two-player reference game,
then a second game to prove reuse. Measure p50/p95 input-to-remote-display delay,
jitter, snapshot age, disconnect/recovery time, and messages/bytes per player.
Test nearby and distant players, simulated loss, and simultaneous rooms across
multiple games. Choose and publish supported player counts and latency budgets
from those results. Vertical scaling can reduce overload latency; it cannot
remove network distance. The platform solves networking once for a defined
casual-game envelope, without claiming every genre or geography has equal latency.

The loop records capability decisions, selected SDK version, compatibility
failures, and test evidence in its visible run history. Existing arbitrary
multiplayer games need an integration step to gain these benefits; listing an
external game alone does not change its networking.

## Pluggable multiplayer module and development

Proposed package: `packages/multiplayer`. Its interface is environment-neutral
and browser-compatible; generated games import it instead of Supabase directly.
The module owns the room lifecycle, transport, synchronization, recovery, and
diagnostics. Game-specific input validation, simulation, state serialization,
and optional prediction remain game code with explicit hooks. A shared networking
module cannot infer arbitrary game rules or automatically reconcile every state.

Keep the interface small: create or join a session, submit an input, subscribe to
state/status, and leave. Session creation returns explicit operational errors;
subscriptions return cleanup functions. The module owns ordering and reconnect
rules rather than asking each caller to coordinate connection setters. A trusted
runtime supplies game identity, environment, and scoped session authorization.
Game code cannot choose another game's schema or production credentials.

| Mode | Game frontend | Multiplayer backend | Purpose |
| --- | --- | --- | --- |
| Local | Local dev server / multiple browser windows | Local Supabase stack with seeded test identities | Develop without a platform account; reproducible multiplayer tests |
| Staging | Local dev server or private uploaded preview | Shared US staging Supabase project | Playtest with other developers over real network connections |
| Production | Published immutable Vercel build | Shared US production Supabase project | Public play |

Use the same Supabase adapter locally and remotely with different trusted
configuration; local tests exercise actual Broadcast, Presence, and authorization.
An internal deterministic adapter may inject delay, disconnects, and dropped
messages for protocol tests. A mock-only test is not evidence of working remote
multiplayer. Supabase's CLI local stack requires a compatible container runtime;
the desktop setup should detect it and offer a visible setup path. Do not add a
container requirement to ordinary single-player development.

Suggested desktop flow: **Play → Local multiplayer → Open second player**, or
**Play → Staging playtest → Create room → Copy invite**. Staging access uses the
developer's platform account and an allowlisted pilot entitlement, not their
harness identity. Local development remains account-free. Staging testers use
staging identities or narrowly scoped, expiring room invites; production tokens
and production gamer data are never reused there.

A remote tester cannot load another developer's localhost. To share a playtest,
upload a frozen private preview build and attach its URL to the room invite, or
have both developers run the same compatible build locally. Private previews do
not create public catalog entries. The preview player must perform actual access
checks; an unlisted static URL alone is not private. Invites expire, preview
retention is bounded, and room compatibility checks bind the game, build, and
protocol versions. Hot reload reconnects or ends the session explicitly; peers
never silently mix incompatible simulations.

Show the environment, room code, player connections, round-trip timing, and
reconnect state in a developer overlay. Record joins, departures, failures, and
module diagnostics in the desktop log. Do not log auth tokens or room invites.
Make simulated latency/loss available in local testing. The production player
does not need developer configuration controls.

Version migrations and test seeds alongside the module. Apply changes locally,
verify staging with at least two clients and multiple isolated games, then
promote the tested build and migrations to production. Promotion never copies
staging users, saves, or room state. Production startup rejects staging/local
configuration. Test expired invites, unauthorized cross-game access, incompatible
versions, host disconnect, and clean session teardown through the same interface.

Future region selection belongs behind session creation: the platform resolves
the room's endpoint and keeps its participants together. Do not implement a
multi-region adapter now, or expose region selection throughout game code.

## Deferred platform monetization

Record per-game storage, realtime traffic, active rooms, and bandwidth from the
start for capacity planning. Later options include platform subscriptions for
publishing capacity or higher hosting limits. No billing, revenue sharing, game
economies, or payout infrastructure is part of this release. Choose a business
model after real usage establishes cost; usage records do not imply a charge.

## Delivery sequence and acceptance

1. **Catalog with Pac-Man:** Vercel catalog and game page, Supabase auth and publisher
   ownership, and an authenticated form to register an existing public game URL.
   Add Pac-Man as the first real entry once its public URL is verified. Visitors
   browse and play without signing in. Use real publisher accounts for our team.
2. **Managed publishing and desktop integration:** authenticated artifact upload,
   build packaging, browser sign-in, release preview,
   resumable publication status, and permanent links using the same service.
3. **Public publishers:** open signup after testing cross-account isolation,
   upload limits, game-origin isolation, reporting/takedown, and spending controls.
4. **Shared multiplayer:** build and benchmark the common Supabase SDK with two
   casual games, test cross-game isolation and reconnects, then require supported
   multiplayer loops to use that SDK. Establish this before advertising automatic
   multiplayer publishing; do not provision per-game realtime servers. Deliver
   local two-player testing and shared US staging playtests as part of this
   milestone, before enabling production multiplayer.

The first catalog milestone passes when an authenticated developer registers
Pac-Man; an unauthenticated visitor opens and plays it from the grid; another
account cannot mutate its listing; and local development still works with no
publishing account. The managed-publishing milestone additionally requires that
a failed update preserves the playable release. Verify that publishing sends
only the release artifact and approved public metadata, and that browser game
code cannot access the publisher session. Deployment setup needs the target
Vercel team/project, Supabase project, and production domains.

## Provider references

Checked 2026-09-05:

- [Vercel CDN](https://vercel.com/docs/cdn)
- [Vercel deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
- [Vercel WebSockets and lifecycle constraints](https://vercel.com/docs/functions/websockets)
- [Supabase Storage quickstart and HTML behavior](https://supabase.com/docs/guides/storage/quickstart)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase database per project](https://supabase.com/docs/guides/database/overview)
- [Postgres tables and schemas](https://supabase.com/docs/guides/database/tables)
- [Supabase Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- [Supabase Realtime cluster architecture](https://supabase.com/docs/guides/realtime/architecture)
- [Supabase local development](https://supabase.com/docs/guides/local-development)
- [Supabase staging and production environments](https://supabase.com/docs/guides/deployment/managing-environments)
