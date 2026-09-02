/**
 * The engine every generated game is built on.
 *
 * The loop's prompt used to be the user's art direction and nothing else, so
 * each game invented its own architecture: six loops produced six hand-rolled
 * plain-JavaScript codebases, none with an ECS and only one with a physics
 * library — and that one was not built here. The stack below is injected into
 * every implement prompt, scaffolded into every workspace, and enforced by a
 * gate the critic runs, so "the engine" is a property of the program rather
 * than of whoever typed the prompt.
 */

/**
 * Pinned exactly, never with a caret. Three.js makes breaking changes on minor
 * versions and img2threejs generates code against whichever version it was
 * told about, so a floating range silently desynchronises the assets from the
 * renderer.
 */
export const ENGINE_DEPS: Record<string, string> = {
  three: '0.185.1',
  bitecs: '0.4.0',
  '@dimforge/rapier3d-compat': '0.20.0',
  howler: '2.2.4',
}

export const ENGINE_DEV_DEPS: Record<string, string> = {
  '@types/howler': '2.2.12',
  '@types/three': '0.185.0',
  typescript: '5.9.3',
  vite: '7.3.6',
}

/** Optional — only pulled in when bots need real navigation meshes. */
export const ENGINE_OPTIONAL_DEPS: Record<string, string> = {
  'recast-navigation': '0.43.1',
}

export const SRC_DIRS = ['src/sim', 'src/sim/systems', 'src/render', 'src/assets', 'src/audio', 'tools']

/**
 * bitECS 0.4.0 rewrote the API: `defineComponent`, `Types.*` and `defineQuery`
 * no longer exist. Every model's memory of the library predates the rewrite,
 * so left to itself the orchestrator writes 0.3-era code that does not even
 * import. Spelling the real API out here is what stops that, and the gate's
 * first check catches it when this does not.
 */
function bitecsApi(): string {
  return `bitECS 0.4.0 — the API is NOT what you remember. \`defineComponent\`, \`Types.f32\` and \`defineQuery\` DO NOT EXIST. Components are plain objects you author and register on the world:

\`\`\`ts
import { createWorld, query, addEntity, addComponent, removeEntity } from 'bitecs'

const world = createWorld({
  components: {
    Transform: { x: new Float32Array(MAX), y: new Float32Array(MAX), z: new Float32Array(MAX),
                 qx: new Float32Array(MAX), qy: new Float32Array(MAX),
                 qz: new Float32Array(MAX), qw: new Float32Array(MAX) },
    Body: { handle: new Uint32Array(MAX) },   // Rapier RigidBody handle
    View: { index: new Uint32Array(MAX) },    // slot in the view registry
  },
  time: { delta: 0, elapsed: 0, then: performance.now() },
})
const { Transform, Body } = world.components
const eid = addEntity(world)
addComponent(world, eid, Transform)
for (const eid of query(world, [Transform, Body])) { /* ... */ }
\`\`\`

Structure-of-arrays for anything touched per frame. Array-of-structs (\`const Names = [] as string[]\`, indexed by \`eid\`) is fine for cold data that never is.`
}

/** The layering rule, stated so a reviewer can check it mechanically. */
function architecture(): string {
  return `Architecture — state lives in bitECS, motion is decided by Rapier, Three.js only draws. Data flows one way per frame and never back:

    Rapier bodies --> bitECS components --> Three.js Object3D
       (truth)          (game state)          (view only)

- No game state on a \`THREE.Object3D\` — not on \`.userData\`, not on a subclass field. An Object3D is a drawing of an entity, not the entity.
- No classes holding entity state. No \`class Player\`, no \`class Enemy\`. An entity is an integer.
- Nothing reads a transform off Three.js; gameplay reads the \`Transform\` component.
- Nothing writes a transform except the physics sync. To move something, apply a force or set the Rapier body's translation.
- \`src/sim/\` must never import \`three\`. If the simulation cannot run headless with no DOM and no WebGL context, the boundary is broken.
- Never allocate inside a per-frame system: no \`new THREE.Vector3()\`, no \`new Quaternion()\` in a system body. Scratch objects are module-level singletons. A system that allocates cancels out the reason bitECS is here.

Fixed frame order: time -> input -> ai -> intent-to-force -> \`world.step()\` (Rapier; the only thing that moves anything) -> physics-to-ecs -> attachment -> gameplay -> audio -> render.`
}

/** How an img2threejs asset becomes an entity. */
function assetSeam(): string {
  return `Assets — build models with the \`/img2threejs\` skill (available to you; one reference image in, a procedural Three.js factory out in TypeScript). It returns a \`THREE.Group\` carrying \`userData.sculptRuntime\` (nodes, sockets, colliders, destructionGroups) and \`userData.rig\` (bones, skeleton, boneOrder, boneIndex, bound).

The Group is a VIEW, never an entity. Call each factory ONCE, extract what it carries into a plain record, then spawn cheaply from that — calling the factory per enemy is the mistake that eats the frame budget:

\`\`\`ts
interface AssetRecord {
  prototype: THREE.Group          // called once, kept as the template
  colliders: ColliderSpec[]       // from sculptRuntime.colliders
  sockets: Map<string, Transform> // named local offsets from sculptRuntime.sockets
  skinned: boolean                // from rig.bound
}
\`\`\`

- Colliders map straight across: box -> \`ColliderDesc.cuboid\`, sphere -> \`ball\`, capsule -> \`capsule\`, cylinder -> \`cylinder\`. Anything that does not map fails the load loudly — never silently fall back to a trimesh, which costs the frame budget invisibly and will not show up in a screenshot.
- Sockets are attachment points as component data (\`Attached: { parent, socket }\`), resolved after physics and before render. Do NOT use \`Object3D.add()\` to parent one entity's view to another's — that puts game state back in the scene graph.
- Check \`rig.bound\` at load; if false a skinned mesh failed to bind, so fail the load rather than shipping a model that renders as a puddle.

Animation state is a component (\`{ state, prev, blend, time }\` typed arrays) driving one \`AnimationMixer\` per skinned view. Do NOT give each entity a state-machine actor or its own behaviour-tree object graph — that reintroduces exactly the per-entity allocation bitECS exists to remove. One shared stateless tree walked against per-entity blackboard components.`
}

/** Audio, and the one thing Howler will not do for you. */
function audio(): string {
  return `Audio — Howler owns loading, sprites, pooling and autoplay unlock. Its 3D panning and Three.js \`PositionalAudio\` are the same Web Audio \`PannerNode\` underneath, so do not expect better sound from it, and do not use both.

- Howler does not know about the Three.js camera. The audio system drives it every frame from the camera's \`Transform\`: \`Howler.pos(...)\` and \`Howler.orientation(...)\`. Nothing else may call those.
- One \`Howl\` per sound, pooled. Never one per entity. A positioned emitter is a component holding a sound id and the playback id it currently owns; use \`sculptRuntime.sockets\` as the emitter points, so a muzzle socket is where the gunshot comes from.`
}

/** Rapier's sharp edges, both of which cost a round to rediscover. */
function physics(): string {
  return `Physics — \`@dimforge/rapier3d-compat\`, and \`await RAPIER.init()\` before the first world (the compat build inlines the WASM so Vite needs no extra configuration). One \`World\`, one fixed timestep set explicitly; never step Rapier with a raw frame delta. If the game has an authoritative server, do not assume two machines stepping the same inputs agree — broadcast state, do not run lockstep.`
}

/** The block appended to every implement prompt. */
export function engineContract(): string {
  const deps = Object.entries(ENGINE_DEPS)
    .map(([name, version]) => `${name}@${version}`)
    .join(', ')
  return `Engine stack (MANDATORY — this is the engine, not a suggestion). Build on exactly these, pinned exactly, no caret ranges: ${deps}. TypeScript with \`strict: true\`, ES modules, Vite. Do NOT add React, react-three-fiber, \`@react-three/*\`, another ECS, or another physics or audio library — we are building our own stack and a framework wrapper would own the seams that are the point. \`recast-navigation@${ENGINE_OPTIONAL_DEPS['recast-navigation']}\` is the one permitted addition, and only when bots need real navigation meshes.

The workspace is already scaffolded with these dependencies, the \`src/sim\` / \`src/render\` / \`src/assets\` / \`src/audio\` layout, \`CONTRACT.md\`, and \`tools/engine-gate.mjs\`. Build into that layout rather than replacing it.

${architecture()}

${bitecsApi()}

${physics()}

${assetSeam()}

${audio()}

Run \`node tools/engine-gate.mjs\` before you finish and fix everything it reports. The critic runs it too, and a game that fails it cannot pass however good it looks. Do not edit the gate — the app rewrites it every round.`
}

/** What the critic is told about the gate. Failing it blocks a pass outright. */
export function engineGateRules(): string {
  return `Architecture gate (BLOCKING). Run \`node tools/engine-gate.mjs\` in the workspace. It prints one JSON object and exits 0 or 1, and it checks that the game is actually built on the engine stack: bitECS 0.4 API, no entity state in classes or on \`Object3D.userData\`, the simulation free of \`three\` imports, no per-frame allocation in systems, no React, and the dependency versions pinned. If it exits non-zero you MUST list every violation it reports as a "critical" finding, and "pass" MUST be false no matter how good the game looks — a beautiful game with the architecture traded away is a failed round, because the architecture is the product. Score the visuals as you otherwise would.`
}

