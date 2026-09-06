# Asset Phase — build plan

Reference images become a library of procedural Three.js asset factories using
the `img2threejs` skill, so an implement round wires assets up instead of
sculpting them by hand. This shipped in two cuts: §§1–6 describe the original
design, where sculpting ran as its own `assets` phase role before implement.
**§2b The merge** describes the current architecture — sculpting still runs
the same pipeline, but as part of the implement round's own orchestrator
conversation rather than a separate one. Read §§1–6 for why the pipeline
exists and what it enforces; read §2b for how it is actually invoked today.

---

## 1. Why

The app has never used `img2threejs`. Across all three build logs in the
`engine-test` workspace (12,751 lines): zero `Skill` tool calls, no
`.img2threejs/state.json`, and every one of the 51 mentions of `forge/*.py` is
a `grep` of the skill's own repo rather than a run of it. What landed instead
was 18,531 lines of hand-written asset code that copies the skill's output
shape without running its screenshot-comparison correction loop.

That costs two things. Asset work competes with the game for the same round —
sculpting a dog, tuning difficulty and wiring a HUD all happen inside one
implement attempt. And quality drifts: the header of `src/assets/char/samoyed.ts`
records four ways round 1 lost the shot and how round 2 hand-fixed each, which
is exactly the job that correction loop exists to do.

Nothing catches it. The engine gate's eight checks are all architecture and
dependencies; asset provenance is invisible to it.

Part of the reason was plainer than prompting: the skill was never installed.
It had to already exist at `<userData>/harnesses/claude/skills/img2threejs`, the
config dir every attempt is spawned against, and nothing in the app ever put it
there. A sculptor told to run `forge/state.py` with no skill loaded cannot fail
usefully, so it improvises — which is precisely the hand-written code above.

The skill now ships with the app: vendored in `vendor/img2threejs`, packaged as
an `extraResources` entry, and copied into that harness home (`skills.ts`)
before any round that needs to sculpt. If it is ever missing, the attempt halts
before spawning a single sculptor rather than paying for models nobody can
trust — originally that guard lived in `executeAssets`; after the merge (§2b)
it lives in `executeImplement`.

Once the skill was actually installed, the phase worked as designed — but a
new problem showed up at the architecture level, not the pipeline level: a
round that needed sculpting billed **two** full top-level orchestrator
conversations (`assets`, then `implement`) against the same Claude
subscription usage window instead of one. That is what §2b fixes.

---

## 2. What changes

```
before:    reference → implement 1 → critique 1 → implement 2 → …

original:  reference → assets → implement 1 → critique 1
cut                       ↑                        │
                          └──── asset findings ────┘
                                  (round 2, 3, …)
```

The phase is **re-entrant, not one-shot**. Round 1 builds the cast list. Later
rounds build only what is missing or what the critic flagged. That part is
unchanged by the merge in §2b — only which attempt does the building changed.

---

## 2b. The merge — sculpting moves inside implement

**As shipped, there is no `assets` phase role anymore.** `queueAssets` (the
function that created one) is deleted. What each round still owes gets
computed by `wantedCast(build, verdict)` (`build-runner.ts`) — the same
three-way logic §2's diagram shows (nothing to sculpt / round-1 unbuilt list /
critic-faulted list) — and threaded into the implement prompt instead of
spawning a second attempt:

```
now:  reference → implement 1 (sculpts what wantedCast names, then wires up) → critique 1 → implement 2 (same) → …
```

`composeImplementPrompt` (`shared/prompts.ts`) takes a `wanted` cast-entry
list. When it's empty, the prompt is byte-identical to the original
wire-up-only text (§3.5). When it's non-empty, a new section is prepended
telling the orchestrator to hand each entry to its own `sculptor` subagent
*before* wiring anything up — same crop tool, same source-order rule, same
"abandon a bad crop rather than force it" instruction as the original
`buildAssetsPrompt` (now deleted) — followed by the unchanged wire-up text,
since the orchestrator still wires up the whole cast, freshly sculpted and
previously-built entries alike.

`executeImplement` gained the setup `executeAssets` used to do: install the
skill (halting the attempt if it's missing), scaffold `tools/crop.py`, and write
`.claude/agents/sculptor.md` — all gated on `wantedCast` being non-empty for
this round, computed fresh at execute time. `sculptorAgentMd`, `sculptorRules`,
`assetTargets`, `unbuiltCast`, and the `img2threejs` pipeline itself are
untouched; only the call site moved.

**`executeAssets`/`assetsParser`/`finishAssets`/`assetsPlan` were kept, not
deleted.** They're unreachable from any *new* round, but `resumeBuild`'s
generic "retry the exact last attempt" branch and `recoverAll`'s boot-time
reattach both replay whatever role an attempt already had — so a build with an
in-flight or interrupted `role: 'assets'` attempt from before this merge still
resumes correctly through the old path, which already ends by calling
`queueImplement`. `PhaseRole` keeps `'assets'` in its union for the same reason:
old ledger rows still have it.

**Nothing about §3 changed except what's noted inline** — the cast-list
format (§3.1), the crop tool (§3.3, now scaffolded conditionally), the model
setting (§3.4), the ownership seam (§4), the risks (§5), and the gate's soft
provenance check (§3.8) all work exactly as designed, just invoked from one
attempt instead of two.

---

## 3. What to build

### 3.1 Cast list in the Reference Study

New required artifact `reference/<build>/cast.md`, with matching entries in
`manifest.json`. Per entry:

| Field | What it is |
|---|---|
| `name` | stable slug; becomes `src/assets/<name>.ts` |
| `kind` | character, creature, prop, structure, flora |
| `stills` | one or more paths into `images/` or `journey/` where it is visible |
| `locator` | one line on where in the frame it is — "the white dog, front left" |
| `role` | what it does in play, what it collides with, what attaches to it |
| `priority` | so a truncated round builds the things that matter |

No crop box and no pixel geometry — the Reference Study names the object and
points at frames; finding and cutting it out is the asset phase's job.

**Only sculptable objects go on the list.** A game's neon wall extrusion, bloom
and score popups are not objects and are not entries; they stay with the
implementer. An empty `cast.md` means there is nothing to sculpt.

**New folder `reference/<build>/objects/`** — clean isolated shots of cast
members from wikis, official art, bestiary pages and model viewers. Gameplay
stills alone never guarantee a usable view of every cast member.

Enforcement: extend the `issues[]` list in `scanReferencePack` — every cast
entry names at least one still, and `objects/` is filled where isolated
material could be found. Missing `objects/` material makes a weaker pack, not a
failed one.

### 3.2 The `assets` phase role (superseded — see §2b)

This section describes the original design: a separate phase role. **§2b The
merge** describes the current architecture, where the same dispatch mechanics
below (fan-out, `delegationRules`/`sculptorRules`, the agent-file sibling, the
stream/cost accounting, `awaitChildren`) run inside the implement round
instead of their own attempt. Left here because the mechanics themselves didn't
change — only which attempt invokes them.

`PhaseRole` gained `'assets'` (kept in the type today for old ledger rows, per
§2b, even though no new build uses it).

**One attempt that fans out to one subagent per cast entry.** `BuildRunner` holds a
single `private current: Attachment` (`build-runner.ts:259`) and drives one child
process per build, so parallel attempts would mean restructuring it. Fanning out from
inside one attempt is what implement already does, so the phase inherits:

- `delegationRules(models, referenceDir)`, which covers all four harness
  combinations. It needs a parameter for which model pair to bind — today it
  reads `subagentModel` directly.
- a sibling to `implementerAgentMd()` writing `.claude/agents/sculptor.md` with
  `model: assetModel` and `effort: assetEffort`.
- the `.gauntlet-gamesmith/agents/<slug>.<harness>.jsonl` stream the app already
  parses, so per-asset cost needs no new accounting.
- `awaitChildren` (`build-runner.ts:1039`) and `childrenActive`.

Orchestrator runs on `orchestratorModel`/`orchestratorEffort` like every other
role; `assetModel`/`assetEffort` bind the workers.

**Every cast entry runs the pipeline. There is no complexity threshold.** Simple
entries are cheap — the detail floor for a simple subject is low and the
correction loop's 3-per-pass / 6-total limits are caps, not spend, so a sphere
with a wedge converges on its first vision comparison. Running everything keeps
the gate check and the finding routing unconditional, and leaves no tier for a
worker to under-declare.

Each worker:

1. **Finds and crops its object** with `tools/crop.py` (§3.3).
2. **Runs `img2threejs` properly** — `state.py init`, then `next.py` gated at
   every step. No reconstructing progress from chat history.
3. **Emits `src/assets/<name>.ts`** — a factory returning a `THREE.Group`
   carrying `userData.sculptRuntime` and `userData.rig`.
4. **Leaves evidence** — `.img2threejs/<name>/state.json`, the sculpt spec, the
   assessment, and the render it was judged against.

**Timeout:** its own constant. Reference and critique get 60 minutes, implement
40 idle with a 12-hour cap; assets sits closer to implement. (After §2b's merge,
a round that sculpts shares implement's single 12-hour cap rather than getting
this budget on top — a deliberate choice to keep one constant rather than add
a conditional one, at the cost of the ~18-hour combined ceiling the two
separate attempts used to have.)

### 3.3 `tools/crop.py`

Lives as `CROP_SCRIPT` in `main/asset-phase.ts` and is scaffolded into the
workspace like `tools/engine-gate.mjs`, rewritten every round for the same
reason.

Three subcommands: `sheet` contact-sheets a stills folder or samples a video,
`grid` overlays a labelled grid on a still, `cut` takes a cell range or pixel
box. Crops go to `.img2threejs/<name>/crop/`, never back into the frozen pack.

Four rules the tool implements, each one load-bearing:

- **Aim with the grid, never with pixel coordinates.** Naming "B3:D8" is
  reliable; guessing pixel boxes is not. At 12×8 on a 1920×1080 still each cell
  is 160×135 px.
- **Fill ratio below 0.25 is refused.** `probe_image.py` reports `pass` with
  zero warnings for a crop whose object occupies 8.5% of the frame — widening a
  small box until it clears the 512 px floor turns an object back into a scene,
  which is the intake rubric's top reject. Probe passing is not rubric passing.
- **Upscaling is the flagged fallback**, chosen with `--allow-upscale`. It holds
  macro and meso form and loses micro detail, so the tool tells the worker to
  record low detail confidence in the spec.
- **Expect two passes.** The first box is usually slightly too tight. Looking at
  the crop and adjusting is the loop, and it is cheap because it operates on an
  image rather than a pipeline pass.

**When no crop clears the bar, move to other material rather than forcing one
through** — a bad crop poisons every pass downstream and the pipeline cannot
notice. Ladder, best source first: `objects/` → `images/` → `journey/` →
`motion/` → `video/`. `motion/` is built by `ffmpeg -vf fps=1` over the clip
(`prompts.ts:18`), so the bottom two rungs stand or fall together.

**"No usable crop" is a legal outcome** that the attempt reports, not something a
worker works around.

### 3.4 Model setting in the build form

`BuildModels` (`shared/build.ts:80-92`) gains two fields:

```ts
/** null = no asset phase; implement rounds build their own models, as today. */
assetModel: string | null
assetEffort: string
```

Null is the off switch — it lets the same prompt run with and without the phase
for comparison, and gives pre-existing builds a sane value.

Default `claude-opus-5` at `high`, matching the subagent default because asset
workers *are* fan-out workers. Not the critic's `gpt-5.6-sol`: the critic is
cross-family so it has no attachment to the code, and no adversarial argument
applies to production work. Efforts come from `AGENT_EFFORTS`, not
`orchestratorEfforts()`.

| File | Change |
|---|---|
| `shared/build.ts:80` | `BuildModels` gains `assetModel`, `assetEffort` |
| `shared/build.ts:189` | `StartBuildInput` gains the same two |
| `shared/models.ts` | `AssetFields`, `DEFAULT_ASSET`; fourth argument to `resolveModels`; `normalizeModels` fills older ledger rows |
| `BuildView.tsx` ~1230 | a fourth picker row after Research, same grid |
| `BuildView.tsx:99` | build summary line gains **Assets** |
| `BuildView.tsx` 634, 708, 816, 854 | form state, hydrate, submit, switch-build |

Harness is never stored — `harnessFor(assetModel)` derives it.

### 3.5 The implement prompt shrinks

Lives as `composeImplementPrompt`'s `assetRule` in `shared/prompts.ts`, not a
function called `assetSeam()` (that name never existed in code — this section
was already stale before §2b). It says: the library exists in
`src/assets/<name>.ts`; call each factory once, extract it into a plain
record, spawn from that; never hand-edit a generated factory.

After §2b, `assetRule` is conditional on `wanted` (what `wantedCast` says this
round still owes): empty, it's exactly the wire-up-only text above; non-empty,
a sculpt-first section is prepended naming those entries and how to build them,
before the same wire-up text runs.

Everything else in the implement prompt stays — colliders map straight across
to Rapier shapes, sockets are component data rather than `Object3D.add()`,
check `rig.bound` at load and fail loudly.

### 3.6 Routing the critic's findings

`VerdictFinding` (`shared/build.ts:17-20`) gains an optional target:

```ts
export interface VerdictFinding {
  severity: string
  text: string
  target?: string   // "asset:<name>" | "game" (default "game")
}
```

The runner splits the verdict: asset-targeted findings name what to rebuild,
everything else goes to the implementer. Originally this meant queuing a
separate `assets` attempt before implement, because implement depended on the
library existing first. After §2b, `wantedCast(build, verdict)` computes the
same split — `assetTargets(verdict.findings)` if the critic named specific
assets, else whatever `unbuiltCast` still owes — and `queueImplement` threads
the result straight into the same round's prompt, so the ordering guarantee
("implement depends on the library") now holds *within* one conversation
(sculpt first, per §2b/§3.5) instead of across two attempts.

Code touched — `queueImplement`'s callers, in `build-runner.ts`: reference →
implement, implement → critique → implement, and the equivalent branches in
`resumeBuild`. All four now make one call each; the conditional "queue assets,
else queue implement directly" branching this section originally described is
gone.

The critic already writes `critique/round-N/pairs.json` as
`{shot, ref, winner, why}` per pair (`prompts.ts:67`); a pair whose `why` is
about a model rather than game feel is an asset finding.

**Re-entry lands at the pass the finding belongs to**, not at the start — a
silhouette complaint goes back to the structure pass, a gloss complaint to the
material pass. The skill tracks this in `reviewHistory` and caps corrections at
3 per pass, 6 total. **One re-entry point sits above all the passes: the crop.**
Re-cropping restarts that asset, so a worker should only reach for it when it
can name which frame it wants instead and why.

### 3.7 `objects/` is critic evidence, never a comparison pair

The critic may **read** `objects/` while building expertise, the way it reads
`research.md`. It may not copy one into `critique/round-N/refs/` or cite one in
`pairs.json`. Pairs stay gameplay-to-gameplay: `images/`, `motion/`, `journey/`.

Judging a gameplay screenshot against studio art scores the marketing, not the
game, and it breaks the "as if you did not know which image is which" premise
the pair protocol depends on. The critic still judges every model as it appears
in play, which is the right frame and the kind of finding that routes back as
`asset:<name>`.

### 3.8 The gate learns to see assets

One new check in `GATE_SCRIPT`, `cast-built`: every object named in the cast has
a factory at `src/assets/<name>.ts`.

**Provenance is reported, not enforced** — a correction to an earlier draft.
Requiring `.img2threejs/<name>/state.json` on every factory would fail the
legitimate path where the Asset Build reports an entry unbuildable and the
implementer models it instead, and the only thing that pressure buys is a
worker who fakes a state file. So a factory with no img2threejs execution behind it
is a note on the check, not a violation.

The gate checks that a named asset **exists**, never that anything imports it.
An unused factory is allowed — nothing imports it so Vite drops it from the
bundle, and an asset unused in round 2 may be what round 5 needs.

---

## 4. The ownership seam

Implement **may** change spec inputs — collider shape, socket placement, scale —
and request a regeneration.

Implement **may not** hand-edit a generated factory.

Without this rule the next implement round quietly hand-edits the models, the
state files and evidence renders start describing models that no longer exist,
and the library rots the way `engine-test`'s did — except now we have also paid
for the pipeline.

---

## 5. Risks

**The library is the wrong library.** You build 15 models, the game needs 8 and a
16th nobody listed. Mitigated by the phase being re-entrant: round 1 builds from
the cast list, later rounds add.

**Regenerating breaks what was fine.** A correction loop can chase its tail,
which is why the skill caps at 6. Asset findings get the same severity
discipline as everything else; a minor note rides along to the next natural
regeneration rather than triggering one.

**Cost.** A dozen assets through a staged pipeline is a real budget line. It
parallelises but is not free, and must be visible to the same `overBudget()`
check that already gates rounds.

**The phase cannot reach some games.** Where quality lives in shaders and motion
— neon wall extrusion, bloom, glow trails — no asset pipeline touches it. That
gap stays with the implementer and the engine contract.

---

## 6. Sequence (historical — this was the original ship order)

1. `cast.md` plus the `scanReferencePack` checks.
2. The `assets` phase role, one agent per entry, no routing yet — it runs once
   before implement 1.
3. The model setting, through `BuildModels`, `resolveModels` and the build form.
   Ships with the role, since a nullable `assetModel` is how the phase is turned
   off.
4. Shrink the implement prompt to consume the library.
5. Add `target` to findings, and the routing.
6. Gate checks for asset provenance.

Steps 1–4 shipped and fixed the main problem: assets stopped being sculpted by
hand inside implement rounds. Steps 5–6 kept it from sliding back. §2b is a
later, separate change on top of all six steps — it did not redo any of them,
it only changed which attempt performs step 2's dispatch.
