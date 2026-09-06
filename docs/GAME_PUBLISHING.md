# Game catalog and publishing

Status: accepted v1 boundary, updated 2026-09-06. See [CATALOG.md](CATALOG.md)
for implemented setup, limits, and verification.

## Current product boundary

Developers build locally with their harness accounts. They publish a completed
saved round from Electron using a separate Supabase publisher account. The desktop
owns listing metadata, builds, private previews, explicit promotion, release
history, rollback, unpublish, and sign-out. The Next.js website only exposes a
public game grid, player, and publisher profile. Its browser sign-in/connection
pages are a utility for transferring a publisher session to Electron, not a web
management surface. No manual artifact file input or independent import flow.

Everything belongs in the monorepo: Next.js in `apps/web`, Electron in
`apps/desktop`, shared UI in `packages/ui`, domain operations in `packages/data`,
schema/migrations/generated types in `packages/db`, and artifact contracts/packing
in `packages/publishing`. Shared components use the app logo and design tokens.

Local Supabase owns publisher Auth, catalog metadata, immutable release envelopes,
and one-time desktop connections. Local run history remains SQLite in Electron
main. The app never reads or transfers harness credentials. Publisher eligibility
is administrator-verified monorepo access, with closed public signup for v1.

Only source-derived shipping builds become releases. A release records its run,
round, saved revision, digest, and listing. The backend validates it before
readiness. An explicit generation-checked promotion updates a stable game's
current-release pointer. Failed updates preserve the published version; rollback
uses the same preview/promotion flow. Executable game content has a separate
sandboxed origin and no account/session access.

The first phase runs on a developer machine with local Supabase. Other LAN devices
browse/play without signup; the publishing desktop uses the backend host. There is
no persistent player progress, custom game server, multiplayer, billing, or public
publisher onboarding. Screenshots documenting user flows belong only in PR bodies.

## Hosted phase

Deploy the Next.js website to Vercel, with a separate executable-game origin and
CDN adapter that retains preview authorization and unpublish semantics. A shared
Supabase project owns Auth, Postgres, and Storage per environment. The local Node
game-content host is not itself a serverless deployment. Provision HTTPS domains,
stable signing/encryption secrets, rate limits, retention, and spending controls
before enabling public traffic. Do not copy local credentials into production.

Start in the US. Initial budget target is Supabase Free and the user's roughly
$20/month Vercel budget; verify actual provider quotas and usage charges before
launch. Cloud upgrades and geographic routing are later platform decisions.
Outside developers will use shared hosted staging. Glassbox v1 uses local Supabase.

## Shared multiplayer phase

Build one pluggable, browser-compatible multiplayer module after selecting the
first multiplayer game. Generated games should use its supported protocol instead
of choosing a provider or building a realtime server. Improve ordering, smoothing,
reconnection, latency instrumentation, and rate limits once for all compatible
games. Pin protocol/SDK versions to releases and revalidate upgrades.

Use one shared Supabase project for all games in an environment. A shared project
is not literally a single realtime process, and vertically scaling Postgres cannot
remove geographic latency or automatically raise all Realtime quotas. Benchmark
capacity and network delay separately. Do not send frame-by-frame updates through
Postgres or Vercel request handlers; use the shared transport for transient traffic.

Guest multiplayer should not require signup. A platform-issued guest identity and
scoped room membership still enforce isolation. If gamer accounts are introduced,
use one platform-wide login, not a separate account per game. Persistent game data
is deferred. A dedicated Postgres schema per game inside the shared project is a
candidate for logical isolation; it is not a physically separate database and must
be confirmed before claiming it meets the “each game its own DB” requirement.
Policies and bounded APIs must prevent cross-game access; schema names alone do not.

Authority and disconnect behavior depend on the game. Host-client simulation is
a candidate for low-stakes casual play, not an accepted universal default. Server
simulation requires a shared runtime extension; Supabase messaging does not run
arbitrary game logic. No money, trusted competitive rankings, or monetization in
these games. The platform should select a supported mode early in the loop and
record that decision visibly; late classification cannot convert every custom
networking implementation automatically.

Keep the module's interface small: create/join a session, submit an input,
subscribe to state/status, and leave. Game code supplies validation, simulation,
and serialization hooks. The module owns sequencing, bounded messages, clocks,
snapshot recovery, and reconnection. Trusted configuration supplies environment
and game identity; generated code gets no DDL or privileged database credentials.

Local development uses real local Supabase with multiple player windows, plus a
deterministic fault-injection adapter for delay/loss tests. Shared staging uses
private frozen builds and expiring scoped invites so remote testers can play
without accessing another developer's localhost. Separate staging identities,
room state, and data from production. Room compatibility binds game, build, and
protocol versions. Expose environment, connections, timing, and failures in the
developer overlay and visible run log without logging tokens or invites.

Validate a reusable two-player reference game, then a second game to prove reuse.
Measure p50/p95 input-to-remote-display delay, jitter, snapshot age, reconnection,
and messages/bytes per player under simulated loss and simultaneous rooms. Test
cross-game isolation and incompatible builds. Establish supported player counts
and latency budgets from results before advertising automatic multiplayer support.
Future regional routing belongs behind session creation, not in every game's code.

## Deferred monetization

No billing or creator payouts ship in v1. Measure storage, bandwidth, and realtime
usage before deciding whether platform subscriptions or capacity tiers make sense.
A platform business model can follow observed costs; it does not require monetized
gameplay or user-built payment systems.
