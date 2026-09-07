# Multiplayer V1

The `@glassbox/multiplayer` package provides guest sessions for different game
genres: open-world exploration, co-op platformers, puzzles, party games, arenas,
and racing. Shared rooms, reconnects and snapshot timing are independent of the
chosen genre. Vercel WebSockets and Redis handle networking; Supabase handles
publisher accounts and saved releases. Publishing stays in Electron.

## Scope of a shared session

Every genre has the same V1 limits: up to six guests and **180 seconds of active
shared play**, following a 30-second lobby and four-second countdown. Reconnecting
retains the original deadline. At expiry the game should show a session-ended
state and offer a deliberate new session, or continue single-player if designed
for it. Page reload creates a new guest identity.

An open-world game can offer a short shared exploration session. The size or
layout of its local world is not tied to racing tracks or match objectives, but
V1 does not provide persistent shared worlds, world streaming, interest management,
durable inventory, or progress across sessions. World assets and simulation remain
the game's responsibility. No game genre bypasses the session/player limits.

The relay carries flat, game-defined records with number, boolean and string
values: at most 32 fields, 100 characters per string, 4 KiB per message, and 25
state updates per second from the SDK. State updates can be dropped or superseded;
periodically resend current state and use idempotent revisions as appropriate.
This is not a reliable one-shot event or transaction channel. Ownership and
conflicts for shared interactions must be designed by the game. V1 is intended
for low-stakes play without rewards or monetization; authoritative simulation,
anti-cheat, trusted scores and persistent progress are deferred.

## Game integration

New build workspaces receive `platform/gamesmith.js`, its TypeScript declarations,
and `platform/MULTIPLAYER.md`. The same instructions appear in implementation
prompts and build logs. The implementer chooses whether the requested mechanics
need networking and adapts them to the module. Uploading an arbitrary existing
multiplayer game does not automatically convert its backend.

Ship `gamesmith.multiplayer.json` in the build root:

```json
{"version":1,"mode":"relay","maxPlayers":6,"sessionSeconds":180}
```

The common lifecycle has no vehicle, terrain or spatial-state requirement:

```js
import { MultiplayerClient } from './platform/gamesmith.js'
const client = MultiplayerClient.fromWindow()
let room = await client.join('Guest')
// The first player can call client.room(true) to start the session sooner.
while (!room.startAt) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  room = await client.room()
}
client.connect()
// Use client.serverNow() and room.endAt for the shared session timer.
const unsubscribe = client.onState(snapshot => {
  // Validate and apply snapshot.state according to your game's mechanics.
  // snapshot.playerId identifies the sender; seq/at support ordered presentation.
})
// Republish your current state at an appropriate bounded rate while connected.
client.publish({ ready: true, activity: 'exploring' })
// On exit/session end: unsubscribe(); client.leave()
```

The host injects `window.gamesmith` only for an authorized saved release. It
contains public service locations, game/release IDs, and a short-lived preview
capability when applicable. Tickets stay in memory and go in the first socket
frame. Games receive no publisher credentials. Use relative asset paths and
handle unavailable browser storage in the sandbox. Single-player features can
remain independent of this module.

## Choose presentation for the game

The transport's `State` is a game-defined record. Smoothing is optional:

| Presentation | Module | Example |
| --- | --- | --- |
| Spatial movement | `TransformBuffer` | Avatars exploring a 3D world, jumping in a platformer, or moving vehicles/props. |
| Custom continuous/discrete state | `SnapshotBuffer` | Interpolate a progress value while applying puzzle switches or animation labels discretely. |
| State without interpolation | `client.onState` | Apply idempotent per-player selections or readiness flags directly. |
| Existing track-motion integration | `PoseBuffer` | Compatibility for games already using planar position, heading and track progress. |

`TransformBuffer` takes `{x,y,z,vx,vy,vz,qx,qy,qz,qw}`: position, velocity and a
unit rotation quaternion. Set unused axes to zero for a 2D game. It smooths all
three axes, blends rotation along the shorter path, bounds extrapolation and
resets on teleports. The `teleportDistance` option defaults to 50 game units;
choose it for the world's scale. Neither track progress nor vehicle speed is required.
Keep one buffer per remote player/entity, push the snapshot timestamp/sequence,
validated transform and `client.serverNow()` as arrival time, then render
`buffer.sample(client.serverNow())` each frame.

`SnapshotBuffer` shares that timing/jitter handling while the game specifies how
its fields change. For example:

```js
import { SnapshotBuffer } from './platform/gamesmith.js'
const buffer = new SnapshotBuffer({
  interpolate(previous, next, alpha) {
    return {
      // Discrete flags, labels and revisions switch at the next snapshot.
      ...(alpha < 1 ? previous : next),
      progress: previous.progress + (next.progress - previous.progress) * alpha,
    }
  },
})
```

Its `interpolate` callback is required. Optional `extrapolate(state, seconds)`
and `discontinuity(previous, next)` callbacks cover game-specific prediction and
resets. Without extrapolation it holds the latest state through an outage.
The default presentation delay adapts between 80–180 ms; extrapolation defaults
to at most 80 ms. Stale frames are rejected, retained history is bounded, and
render time moves forward. These helpers cannot eliminate latency or infer game
rules, world authority, animation semantics or conflict resolution.

Workspace consumers import the lifecycle from `@glassbox/multiplayer/client`
and optional presentation helpers from `@glassbox/multiplayer/smoothing`.
Generated games use the bundled `./platform/gamesmith.js` entry point.

## Local testing

Use Node 22 and Docker Desktop. `pnpm catalog:up` starts local Supabase and the
isolated Redis container, builds the site, then runs catalog/game/relay servers.
For an already-running Supabase environment:

```sh
pnpm multiplayer:redis
pnpm catalog:dev
GAUNTLET_CATALOG_URL=http://127.0.0.1:4310 GAUNTLET_GAME_ORIGIN=http://127.0.0.1:4311 pnpm dev
```

Defaults are catalog 4310, game files 4311, relay 4312 and Redis 56329. Redis/admin
ports bind to loopback. For testing within a trusted LAN, set `CATALOG_HOST` to
the development computer's LAN address before starting the catalog. Shared
staging needs separate Supabase credentials, signing secret and Redis namespace.
Do not expose database/admin ports or use production for untrusted previews.

Preview a saved round in Electron, duplicate its private-preview URL in another
browser, and join with two names. Verify the game's actual shared interactions,
movement if present, lobby leave, reconnect and the original session deadline.
Use the SDK's incoming-state delay presets and diagnostics when useful; the
presets do not emulate every property of a poor connection. Bots and local
simulation alone do not prove multiplayer. Historical hosted browser validation
used a racing game as one integration example; it is not a required game template.

```sh
pnpm typecheck
pnpm test
MULTIPLAYER_TEST_REDIS=redis://127.0.0.1:56329 pnpm multiplayer:test
pnpm build
```

To verify the deployment protocol, save an actual private-preview URL as
`{"url":"..."}` in a private JSON file outside Git and run
`pnpm multiplayer:smoke /absolute/path/to/preview.json`. It uses one real
three-minute session to check matching, leave, state delivery with incoming
delay, a forced TCP disconnect, identity-preserving reconnect and the original
deadline. It sends synthetic 3D movement and discrete activity state, independent
of the example game's rules. It does not replace playtesting those rules.
Optional `MULTIPLAYER_SMOKE_RESULT` writes metrics outside the repository;
output excludes preview URLs and tickets.

Redis integration tests use independent adapters and clean up only their own
random namespace. The test is skipped without `MULTIPLAYER_TEST_REDIS`. Tests
cover 3D spatial state and non-spatial puzzle state, generic interpolation and
legacy track-motion compatibility. Do not check in builds or credentials.

## Operations

See [deployment](DEPLOYMENT.md) for the two Vercel projects and environment.
Rooms, state and rate counters expire in Redis. Each warm function unsubscribes
when its last room listener leaves. Assets remain in Supabase Storage. V1 runs
in US `iad1` under the configured free-plan quotas. At quota, expose the real
connection failure and allow retry. Authoritative hosting and multi-region
routing are future adapters behind the game-facing interface.
