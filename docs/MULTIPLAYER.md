# Multiplayer V1

Gamesmith supports optional guest races through Vercel WebSockets and shared
Redis. Supabase handles publisher accounts and saved releases. The public site
still only browses/plays games; publishing stays in Electron.

## Game integration

New build workspaces receive `platform/gamesmith.js` and `platform/MULTIPLAYER.md`.
The same instructions are included in every implementation prompt and run log.
The run's implementer chooses whether the requested mechanics need networking.
It must adapt those mechanics to the SDK; existing arbitrary multiplayer games
are not automatically converted just by uploading them.

Ship `gamesmith.multiplayer.json` in the build root:

```json
{"version":1,"mode":"relay","maxPlayers":6,"sessionSeconds":180}
```

```js
import { MultiplayerClient, PoseBuffer } from './platform/gamesmith.js'
const client = MultiplayerClient.fromWindow()
let room = await client.join('Guest')
// Poll client.room() once per second while in the lobby.
// First player can call client.room(true) to start early.
// Once startAt exists, connect during its countdown.
while (!room.startAt) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  room = await client.room()
}
client.connect() // use client.serverNow() for all race deadlines
const unsubscribe = client.onState(snapshot => {
  // Keep a PoseBuffer per player; push the timestamped pose, never snap a view.
})
// Called by the game: client.publish({x, z, heading, s, vx, vz, speed})
// Dispose on exit: unsubscribe(); client.leave()
```

The host injects `window.gamesmith` from the validated saved release. It contains
only API location, release/game IDs and (for previews) a short-lived preview
capability. Tickets stay in memory and go in the first socket frame, never a URL.
No publisher/Supabase credentials go to games. Use relative asset paths and
handle unavailable localStorage inside the sandbox. Single-player code remains
independent of this declaration and SDK.

A room starts after its 30-second lobby plus a four-second countdown. Its active
session ends after 180 seconds even if clients reconnect. Up to six guests join
one game/release/access scope. Private-preview and public rooms are separate.
A brief disconnect reuses the ticket; page reload starts a new guest identity.
Leaving before start frees the seat when the server receives the request.

This relay validates capabilities, membership, bounded messages, update rate and
deadlines. The game still owns its simulation and gameplay rules. It does not
validate racing physics or scores. Authoritative shared physics, combat,
anti-cheat, persistent scores, Colyseus and multi-region routing are deferred.

## Local testing

Use Node 22 and Docker Desktop. `pnpm catalog:up` starts local Supabase and the
isolated Redis container, builds the site, then runs catalog/game/relay servers.
For an already-running Supabase environment:

```sh
pnpm multiplayer:redis
pnpm catalog:dev
GAUNTLET_CATALOG_URL=http://127.0.0.1:4310 GAUNTLET_GAME_ORIGIN=http://127.0.0.1:4311 pnpm dev
```

The defaults are catalog 4310, game files 4311, relay 4312 and Redis 56329.
All Redis/admin ports bind to loopback. To share game testing within a trusted
LAN, set `CATALOG_HOST` to the development computer's LAN address before starting
the catalog; this advertises the reachable game/API/socket URLs. Publisher
operations can stay on the development computer. Do not expose Supabase or
Redis admin ports. Shared staging needs separate Supabase credentials, signing
secret and Redis namespace; never point untrusted previews at production.

Preview the saved round in Electron, duplicate its private-preview URL in a
second browser, and join with two names. Check that both players see each other,
remote motion is continuous, lobby leave frees a seat, reconnect keeps the same
identity, and both reach results at the original deadline. Racing's private
preview exposes incoming-state delay presets and connection/RTT/snapshot-age
metrics. Those presets delay snapshots only; real round-trip latency remains
measured separately. Bots are explicitly labeled and are not multiplayer proof.

```sh
pnpm typecheck
pnpm test
MULTIPLAYER_TEST_REDIS=redis://127.0.0.1:56329 pnpm multiplayer:test
pnpm build
```

To verify a deployment, save its actual private-preview URL as `{"url":"..."}`
in a private JSON file outside Git. Then run
`pnpm multiplayer:smoke /absolute/path/to/preview.json`. This spends one real
three-minute test match. It checks guest matching, leave, state delivery under
incoming delay, a forced TCP disconnect, identity-preserving reconnect and the
original server deadline. Output excludes preview URLs and tickets. Optional
`MULTIPLAYER_SMOKE_RESULT` writes the resulting metrics JSON outside the repo.

The Redis integration test uses independent adapters and removes only its own
random namespace. Without `MULTIPLAYER_TEST_REDIS` that one test is skipped.
Do not store builds, credentials or screenshot catalogs in Git.

## Operations

See [deployment](DEPLOYMENT.md) for the two Vercel projects and environment.
Rooms, state and rate counters expire in Redis. Each warm function unsubscribes
when its last room listener leaves; game assets remain in Supabase Storage.
At the free-plan quota, show connection errors and allow retry; do not substitute
bots and call the game online. The SDK surface permits a later authoritative
runtime adapter without rewriting the public catalog or publisher identity.
