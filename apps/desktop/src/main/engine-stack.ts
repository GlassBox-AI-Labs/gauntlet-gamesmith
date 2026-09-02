import fs from 'node:fs'
import path from 'node:path'

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

const SRC_DIRS = ['src/sim', 'src/sim/systems', 'src/render', 'src/assets', 'src/audio', 'tools']

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

/**
 * The gate. Static checks only: it never builds or runs the game, so it costs
 * nothing and cannot be flaked by a broken build.
 *
 * The app rewrites this file every round on purpose. It is the one thing in
 * the workspace a worker has an incentive to weaken — a gate that can be
 * edited to pass is not a gate.
 */
export const GATE_SCRIPT = `#!/usr/bin/env node
// Generated by Gauntlet Loop. Rewritten every round — edits will not survive.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const DEPS = ${JSON.stringify(ENGINE_DEPS)}
const BANNED_DEPS = /^(react|react-dom|@react-three\\/|@types\\/react)/

function walk(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = path.posix.join(dir, entry.name)
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) out.push(...walk(rel))
    else if (/\\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(rel)
  }
  return out
}

const files = walk('src')
const source = new Map(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\\r?\\n/)]))
const checks = []

function scan(id, why, pattern, filter) {
  const violations = []
  for (const [file, lines] of source) {
    if (filter && !filter(file)) continue
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
      if (pattern.test(line)) violations.push({ file, line: i + 1, text: line.trim().slice(0, 160) })
    })
  }
  checks.push({ id, why, ok: violations.length === 0, violations })
}

const under = (prefix) => (file) => file.startsWith(prefix)
const notUnder = (prefix) => (file) => !file.startsWith(prefix)

scan('bitecs-0.4-api', 'bitECS 0.4 removed defineComponent/defineQuery/Types.* — this code targets the old API and will not import',
  /\\b(defineComponent|defineQuery|defineSerializer|defineDeserializer|Types\\.[a-z])/)

scan('no-entity-classes', 'entity state belongs in bitECS components, not class fields',
  /^\\s*(export\\s+)?(abstract\\s+)?class\\s+\\w/, under('src/sim/'))

scan('no-state-on-views', 'a THREE.Object3D is a drawing of an entity, not the entity',
  /\\.userData\\b/, notUnder('src/assets/'))

scan('transform-writes', 'only the render system may write a view transform; gameplay writes the Transform component',
  /\\.(position|quaternion|rotation|scale)\\s*\\.\\s*(([xyzw]\\s*(=[^=]|\\+=|-=|\\*=))|(set|copy|setScalar|addScaledVector|applyQuaternion)\\s*\\()/, notUnder('src/render/'))

scan('sim-is-headless', 'src/sim must run with no DOM and no WebGL — it may not import three',
  /from\\s+['"]three['"]|require\\(['"]three['"]\\)/, under('src/sim/'))

scan('no-per-frame-alloc', 'allocating in a system body defeats the reason bitECS is here — use module-level scratch',
  /new\\s+(THREE\\.)?(Vector[234]|Quaternion|Matrix[34]|Euler|Color|Object3D|Box3|Ray)\\b/, under('src/sim/systems/'))

// Three of the checks above are scoped to src/sim/, so a game with no
// simulation layer would pass them by having nothing to inspect — the easiest
// way to satisfy the gate would be to skip the architecture entirely.
const simFiles = files.filter((f) => f.startsWith('src/sim/'))
const renderFiles = files.filter((f) => f.startsWith('src/render/'))
const layoutViolations = []
if (simFiles.length === 0) layoutViolations.push({ file: 'src/sim/', line: 0, text: 'no simulation layer — game state and systems belong here, not in the renderer' })
if (renderFiles.length === 0) layoutViolations.push({ file: 'src/render/', line: 0, text: 'no render layer — the Transform-to-Object3D sync belongs here' })
checks.push({ id: 'engine-layout', why: 'the sim/render split is the architecture; without it the other checks have nothing to inspect', ok: layoutViolations.length === 0, violations: layoutViolations })

let pkg = null
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
} catch {
  /* reported below */
}
const depViolations = []
if (!pkg) depViolations.push({ file: 'package.json', line: 0, text: 'missing or unparseable' })
else {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  for (const [name, want] of Object.entries(DEPS)) {
    if (!all[name]) depViolations.push({ file: 'package.json', line: 0, text: name + ' is missing — required at ' + want })
    else if (all[name] !== want) depViolations.push({ file: 'package.json', line: 0, text: name + ' is ' + all[name] + ', must be pinned to exactly ' + want })
  }
  for (const name of Object.keys(all)) {
    if (BANNED_DEPS.test(name)) depViolations.push({ file: 'package.json', line: 0, text: name + ' is banned — we build our own stack, no React or R3F' })
  }
}
checks.push({ id: 'pinned-stack', why: 'the engine stack is pinned exactly and React is not part of it', ok: depViolations.length === 0, violations: depViolations })

const failed = checks.filter((c) => !c.ok)
const violationCount = failed.reduce((n, c) => n + c.violations.length, 0)
console.log(JSON.stringify({ ok: failed.length === 0, filesScanned: files.length, violationCount, checks }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
`

function starterPackageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc --noEmit && vite build',
        preview: 'vite preview',
        gate: 'node tools/engine-gate.mjs',
      },
      dependencies: ENGINE_DEPS,
      devDependencies: ENGINE_DEV_DEPS,
    },
    null,
    2,
  )}\n`
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['ES2022', 'DOM'],
    },
    include: ['src', 'tools'],
  },
  null,
  2,
)}\n`

/** The contract, on disk, for workers that read files rather than the prompt. */
export function contractMd(): string {
  return `# Engine — build contract

Generated by Gauntlet Loop and rewritten every round. Do not edit: your changes
will be overwritten, and the gate enforces this file whatever it says here.

${engineContract()}
`
}

export interface ScaffoldResult {
  created: string[]
  refreshed: string[]
}

/**
 * Give a new workspace the engine before round one starts.
 *
 * Split deliberately into two kinds of file. The game's own files — the
 * manifest, the tsconfig, the source tree — are written only when absent, so a
 * round-seven workspace that has grown real dependencies is never clobbered.
 * The app's files — the contract and the gate — are rewritten every round,
 * because a contract that drifts is not a contract and a gate a worker can
 * edit to pass is not a gate.
 */
export function scaffoldEngine(workspaceDir: string): ScaffoldResult {
  const created: string[] = []
  const refreshed: string[] = []

  const writeIfAbsent = (rel: string, body: string): void => {
    const full = path.join(workspaceDir, rel)
    if (fs.existsSync(full)) return
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
    created.push(rel)
  }
  const rewrite = (rel: string, body: string): void => {
    const full = path.join(workspaceDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
    if (before === body) return
    fs.writeFileSync(full, body)
    ;(before === null ? created : refreshed).push(rel)
  }

  for (const dir of SRC_DIRS) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true })

  writeIfAbsent('package.json', starterPackageJson(path.basename(workspaceDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-')))
  writeIfAbsent('tsconfig.json', TSCONFIG)

  rewrite('CONTRACT.md', contractMd())
  rewrite('tools/engine-gate.mjs', GATE_SCRIPT)

  return { created, refreshed }
}
