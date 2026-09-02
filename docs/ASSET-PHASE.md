# Asset Phase — plan

**Status:** proposal, not yet accepted. Written 2026-09-02.

A new run role between the Reference Study and the first implement round. It
turns reference images into a library of procedural Three.js asset factories,
using the `img2threejs` skill, so that implement rounds wire assets up instead
of sculpting them by hand.

---

## 1. Why

We checked whether the app has ever actually used `img2threejs` to make
assets. It has not.

In the `engine-test` workspace, across all three run logs (12,751 lines):

- **Zero `Skill` tool calls.** The skill was available the whole time —
  `img2threejs` appears in both the `skills` and `slash_commands` lists in
  every run's init record, and `Skill` was in the tool list.
- **No `.img2threejs/state.json`**, which the skill treats as its mandatory
  checklist authority. No sculpt spec, no assessment, no detail inventory.
- **No forge script ever ran.** There are 51 mentions of `forge/*.py` in the
  logs; every one is a `grep`, `sed` or `ls` against the skill's own repo. Not
  one `python3 forge/next.py`.
- **What happened instead:** in run 1 the agent ran `find ... -iname
  "*img2threejs*"`, read `SKILL.md`, grepped for `sculptRuntime`, read the
  emit sites in `generate_threejs_factory.py`, and then hand-wrote 18,531
  lines of asset code that honours the output shape. `src/assets/runtime.ts`
  says so in its opening comment.

Two costs follow from that:

**Asset work competes with the game for the same round.** Sculpting a dog,
tuning difficulty, and wiring a HUD all happen in one implement run, under one
40-minute idle timeout and one 12-hour cap.

**Quality drifts and gets fixed by hand.** The header of
`src/assets/char/samoyed.ts` documents four specific ways round 1 lost the
shot — coat clipped to white, legs vanished into the body, tail read as a
chain of balls, fur read as popcorn — each fixed by hand in round 2. That is
the job `img2threejs` has a screenshot-comparison correction loop for, and
that loop never ran.

**Nothing catches it.** The engine gate's eight checks are all architecture and
dependencies: bitECS 0.4 API, no entity classes, no state on views, transform
writes, headless sim, no per-frame allocation, sim/render layout, pinned deps.
Asset provenance is invisible to it.

---

## 2. What changes

Today:

```
reference (round 0) → implement 1 → critique 1 → implement 2 → critique 2 → …
```

Proposed:

```
reference (round 0) → assets (round 0) → implement 1 → critique 1
                          ↑                                  │
                          └──── asset findings ──────────────┘
                                     (round 2, 3, …)
```

The asset phase is **re-entrant, not one-shot**. Round 1 builds the cast list
from the Reference Study. Later rounds build only what is missing or what the
critic flagged.

---

## 3. Two blockers to clear before any of this works

### 3.1 The reference pack has the wrong kind of pictures

`scanReferencePack` requires at least 8 stills, 8 motion frames, 4 ordered
journey shots and a gameplay video (`reference-pack.ts:60-67`). Those are whole
scenes — twenty objects at once, under game lighting.

`img2threejs` takes **one object per image**, and step 2 of the skill is a
validation rubric that rejects unsuitable targets. Pointing an asset phase at
`reference/<loop>/images/` would fail at intake.

**A crop step is required, and it belongs to the asset phase** (decided
2026-09-02 — reasoning in §4.2). Each asset agent finds its object in the
candidate stills, cuts it out, and feeds the crop to its own pipeline. This is
new work, not wiring, and it is the highest-uncertainty piece of the plan.

### 3.2 Nothing upstream names the assets

The implementer currently invents the game's content in round 1. If assets are
built before implement, something has to say what to build. The Reference Study
already writes `story.md` and `journey.md`, so it is the natural place.

---

## 4. Design

### 4.1 The reference phase gains a cast list

New required artifact, `reference/<loop>/cast.md`, with matching entries in
`manifest.json`. Per entry:

| Field | What it is |
|---|---|
| `name` | stable slug; becomes `src/assets/<name>.ts` |
| `kind` | character, creature, prop, structure, flora |
| `stills` | one or more paths into `images/` or `journey/` where it is visible |
| `locator` | one line on where in the frame it is — "the white dog, front left" |
| `role` | what it does in play, what it collides with, what attaches to it |
| `priority` | so a truncated round builds the things that matter |

Note what is *not* here: no crop box, no pixel geometry. The Reference Study
names the object and points at frames it appears in; finding and cutting it out
is the asset phase's job.

**It also needs a new folder, `objects/`** (though see §9.2: some games stage
their own hero shots and need it less) — and this is a correction to an
earlier claim in this document. Writing a cast list was supposed to be the only
change to the Reference Study. The spike showed that is not enough: the pack's
gameplay stills are five different enemies in five different fights, so a cast
entry that appears cleanly in none of them has nowhere else to go (§9). The
Reference Study has to gather object reference material as its own category —
clean, isolated shots of each named cast member from wikis, official art,
bestiary pages and model viewers — or the cast list can name things the pack
cannot support.

Enforced the same way everything else in the pack is: extend the `issues[]`
list in `scanReferencePack` — cast entries present, and an `objects/` shot for
every entry above a priority threshold.

### 4.2 A new `assets` run role

`RunRole` becomes `'reference' | 'assets' | 'implement' | 'critique'`.

One agent per cast entry — assets are independent, so this fans out. Each
agent:

1. **Finds and crops its object** with `tools/crop.py`, scaffolded into the
   workspace the way `tools/engine-gate.mjs` already is. It contact-sheets the
   candidate material, picks the frame that shows the object best, cuts, looks
   at the result, and adjusts. The crop is written to
   `.img2threejs/<name>/crop/` — never back into the frozen reference pack.

   **If no crop clears the bar, it abandons that frame and moves to other
   material rather than forcing one through.** A bad crop poisons every pass
   downstream and the pipeline cannot notice. The ladder, best source first:
   `objects/` → `images/` → `journey/` → `motion/` → `video/` → report the
   entry unbuildable. §9 has what we know about each rung — the bottom two are
   derived from the same clip, so they stand or fall together.

   Spiked and working; results in §9.
2. Runs `img2threejs` properly: `state.py init`, then `next.py` gated at every
   step. No reconstructing progress from chat history.
3. Emits `src/assets/<name>.ts` — a factory returning a `THREE.Group` carrying
   `userData.sculptRuntime` and `userData.rig`.
4. Leaves evidence: `.img2threejs/<name>/state.json`, the sculpt spec, the
   assessment, and the render it was judged against.

**Why the crop lives here and not in the Reference Study.** Four reasons, in
order of weight:

- **Cropping is a loop, not a cut.** The skill validates the crop at intake and
  can reject it as an unsuitable 3D target. Whoever crops has to be able to
  take that rejection and try a different frame. Only the asset agent is in a
  position to run that loop — a reference agent would be cropping blind.
- **Regeneration needs a fresh crop.** When the critic flags an asset in round
  3, the fix is often a better view of it, not a better sculpt of the same bad
  view. A crop box frozen into the reference pack in round 0 would trap every
  later round with the original mistake. This is the argument that matters
  most, because re-entrancy is the spine of the whole design.
- **The pack is frozen on purpose.** Both the implementer and critic prompts
  say not to replace or redownload it. Derived files belong somewhere
  writable, next to the asset that owns them.
- **The seam stays clean.** The teammate building the Reference Study writes a
  cast list and nothing else changes for them.

The cost is real and worth naming: the asset agent has to re-view stills the
reference agent already looked at, which is duplicated vision work, and a
sloppy locator lets it crop the wrong creature when two similar ones share a
frame. The `locator` line is what holds that closed, and the saved crop means
you pay for it once per asset rather than once per regeneration.

**Timeout.** Reference and critique get 60 minutes; implement gets 40 minutes
idle with a 12-hour cap. Assets sits closer to implement — a staged pipeline
allowing up to 6 corrections per asset, run in parallel across the cast. It
needs its own constant, not a borrowed one.

### 4.3 The asset phase gets its own model setting

`LoopModels` (`shared/loop.ts:80-92`) gains two fields, following the pattern
the Reference Study's research fan-out already uses:

```ts
/** null = no asset phase; implement rounds build their own models, as today. */
assetModel: string | null
assetEffort: string
```

**Null is the off switch, and it turned out to matter more than cost.** The
asset phase is the most expensive thing in the loop — a full `img2threejs`
pipeline per cast entry, run in parallel — so a nullable model lets you run the
same prompt with and without it and compare scores. It also gives every loop
written before the phase existed a sane value.

But §9.2 found the bigger reason. **Some games should not run this phase at
all.** In a Pac-Man Championship Edition 2 pack the sculptable cast is a sphere
with a wedge and four capsules, while everything that makes the game look right
— extruded neon walls, bloom, score-ladder popups, glow trails — is renderer
and shader work an asset pipeline cannot touch. Running the phase there burns a
full round producing trivial models and misses the target entirely.

**The cast list should decide, not the operator.** The Reference Study lists
only what is worth sculpting; an empty or near-empty `cast.md` means the phase
no-ops for that loop and the run form's setting never has to be touched. The
manual null stays as an override and as the A/B switch.

**Default: `claude-opus-5` at `high`** — the same as the subagent default,
because asset agents *are* fan-out workers. Two reasons not to copy the critic's
default of `gpt-5.6-sol`: the critic is deliberately in a different model family
so it has no attachment to the code, and no such adversarial argument applies
here — this is production work, not grading. And the judgment this phase needs
is visual: it compares its own renders against a reference photo, pass after
pass. That is worth paying for, and it is why this should not default to the
cheap tier the way research does.

Efforts come from `AGENT_EFFORTS`, not `orchestratorEfforts()` — asset agents
are workers, so `ultracode` and `ultra` do not apply to them.

What to touch:

| File | Change |
|---|---|
| `shared/loop.ts:80` | `LoopModels` gains `assetModel`, `assetEffort` |
| `shared/loop.ts:189` | `StartLoopInput` gains the same two |
| `shared/models.ts` | new `AssetFields` and `DEFAULT_ASSET`; `resolveModels` takes a fourth argument; `normalizeModels` fills the field for older ledger rows |
| `RunView.tsx` ~1230 | a fourth picker row after Research, same three-column grid |
| `RunView.tsx:99` | the run summary line gains an **Assets** entry |
| `RunView.tsx` 634, 708, 816, 854 | form state, hydrate-from-loop, submit, switch-run |

The harness is never stored separately — `harnessFor(assetModel)` derives it,
the way every other role does.

The one-line explainer under the form follows what `describeCritic` and the
research line already do: with a model set, *each cast entry gets its own agent
on Opus 5 at high effort*; with none, *no asset phase — implement rounds build
their own models*.

### 4.4 The implement prompt shrinks

`assetSeam()` in `shared/engine-stack.ts` currently says "build models with the
`/img2threejs` skill." It becomes: *the library already exists in
`src/assets/<name>.ts`; call each factory once, extract it into an
`AssetRecord`, spawn from that.*

Everything else in that section is already correct and stays — colliders map
straight across to Rapier shapes, sockets are component data rather than
`Object3D.add()`, check `rig.bound` at load and fail loudly.

### 4.5 Routing the critic's findings

This is what makes re-entry work.

`VerdictFinding` is `{severity, text}` today (`shared/loop.ts:17-20`). It gains
an optional target:

```ts
export interface VerdictFinding {
  severity: string
  text: string
  target?: string   // "asset:<name>" | "game" (default "game")
}
```

The runner then splits the verdict. Asset-targeted findings queue an `assets`
run for **those assets only**; everything else goes to implement. Assets runs
first, because implement depends on the library.

Code touched — the four places a run is created for the next role:

- `loop-runner.ts:955-964` — reference finishes, implement 1 is queued
- `loop-runner.ts:1558` — implement finishes, critique is queued
- `loop-runner.ts:1934` — critique finishes, next implement is queued
- `loop-runner.ts:426-470` — the same switch again on the resume path

**The critic already produces the raw material.** Step 6 of the critic prompt
makes it write `critique/round-N/pairs.json` as
`{shot, ref, winner, why}` per comparison pair. A pair whose `why` is about a
model rather than about game feel is an asset finding.

**Re-entry lands at the pass the finding belongs to**, not at the start.
A silhouette complaint goes back to the structure pass; a gloss or colour
complaint to the material pass. The skill tracks this itself in
`reviewHistory` and caps corrections at 3 per pass, 6 total.

**One re-entry point sits above all the passes: the crop.** "This does not look
like the reference" sometimes means the sculpt is wrong and sometimes means it
was built from a frame that hid half the object. Re-cropping from a different
still restarts the pipeline for that asset; correcting a pass does not. An
asset agent should reach for the crop only when it can say which frame it wants
instead and why, otherwise the cheap fix gets skipped in favour of the
expensive one.

### 4.6 The gate learns to see assets

New checks in `GATE_SCRIPT`:

- every `src/assets/<name>.ts` named in `cast.md` exists
- each has its `.img2threejs/<name>/state.json` and an evidence render
- a generated factory has not been hand-edited since generation (record a hash
  at emit time and compare)

The gate checks that a named asset **exists**, never that anything imports it.
An unused factory is allowed — see §7.

### 4.7 `objects/` is evidence for the critic, never a comparison pair

The critic copies the reference stills it judges against into
`critique/round-N/refs/` and records every pair in `pairs.json` as
`{shot, ref, winner, why}`, judging "purely on what is in frame — as if you did
not know which image is which" (`prompts.ts:67`).

An `objects/` shot breaks that protocol three ways:

- **The comparison is unfair by construction.** A wiki render or official art is
  an isolated object, usually studio-lit and often at a fidelity the game itself
  never shows. A gameplay screenshot loses that pair every time, for reasons
  that have nothing to do with the game. The scale says 1.00 is
  "indistinguishable from the AAA reference" — if the reference is marketing
  art, that bar is not the game.
- **The blind test stops working.** "As if you did not know which image is
  which" needs both images to be the same kind of thing. A studio render beside
  a gameplay frame is identifiable at a glance.
- **It is the asset phase's question, asked with worse tools.** "Does this model
  look like that creature?" is exactly what the `img2threejs` correction loop
  does per asset, per pass, against the crop, with state behind it. A critic
  re-running that from a gameplay screenshot adds noise, not signal.

So the rule is a distinction, not a ban: the critic may **read** `objects/`
while building expertise, the way it reads `research.md`. It may not copy one
into `refs/` or cite one in `pairs.json`. Pairs stay gameplay-to-gameplay —
`images/`, `motion/`, `journey/`.

This does not blind the critic to bad models. It still judges every model as it
appears in play, which is the right frame. "The dog reads as a white blob at
gameplay distance" is a real finding, and it is exactly the kind that routes
back as `asset:<name>` under §4.5.

---

## 5. The ownership seam — the thing to get right

Implement **may** change the spec inputs: collider shape, socket placement,
scale. It requests a regeneration.

Implement **may not** hand-edit a generated factory.

Without this rule, the next implement round quietly hand-edits the models, the
state files and evidence renders start describing models that no longer exist,
and the library rots exactly the way `engine-test`'s did — only now we have
also paid for the pipeline.

---

## 6. Risks

**The library is the wrong library.** You build 15 models, the game needs 8 of
them and a 16th nobody listed. *Mitigation:* the phase is re-entrant. Round 1
builds from the cast list; later rounds add. A one-shot upfront phase would
bake in the guess.

**Regenerating breaks what was fine.** A correction loop can chase its tail —
which is why the skill caps at 6 corrections. *Mitigation:* asset findings get
the same severity discipline as everything else. A minor gloss note rides along
to the next natural regeneration rather than triggering one.

**Cost.** A dozen assets through a staged pipeline is a real budget line. It
parallelises, but it is not free, and it needs to be visible to the same
`overBudget()` check that already gates rounds.

**The crop step has no prior art here.** Everything else in this plan is
plumbing we have built before. This one is genuinely new — spike it first.

---

## 7. Decisions taken

**Cropping belongs to the asset phase, not the Reference Study** (2026-09-02).
Cropping is a loop rather than a cut — the skill can reject a crop at intake,
and regeneration in a later round often needs a different frame entirely. A
crop box frozen into the pack at round 0 would trap every later round with the
first mistake. Full reasoning in §4.2.

**The asset phase gets its own model setting in the run form** (2026-09-02),
nullable so the phase can be switched off and measured against a run without
it. Details in §4.3.

**An unused asset is allowed to sit there as dead code** (2026-09-02). If the
critic never mentions it and implement never wires it up, nothing cleans it up
for now. Three reasons this is safe to defer:

- It costs nothing at runtime. Nothing imports it, so Vite drops it from the
  bundle. It is repo weight, not frame budget and not bundle size.
- Deleting it is the expensive mistake. An asset unused in round 2 may be
  exactly what round 5 needs after a critic finding, and regenerating it costs
  a full pipeline run.
- It is a signal worth keeping. A cast list that consistently over-reaches is
  something to fix in the Reference Study's cast rules, and you can only see
  that pattern if the unused assets are still sitting there.

The consequence for §4.6: the gate checks that a named asset exists, never that
something imports it. A build must not fail for carrying a factory nobody
calls.

**`objects/` shots are critic evidence but never critic comparison pairs**
(2026-09-02). Judging a gameplay screenshot against studio art scores the
marketing, not the game, and breaks the blind-pair protocol the critique
depends on. Reasoning in §4.7.

---

## 8. Sequence

1. ~~**Spike the asset agent's crop step.**~~ **Done 2026-09-02** — see §9.
2. **`cast.md` plus the `scanReferencePack` checks.**
3. **The `assets` run role**, one agent per entry, no routing yet — it just
   runs once before implement 1.
4. **The model setting**, through `LoopModels`, `resolveModels` and the run
   form. Ships with the role, since a nullable `assetModel` is also how the
   phase gets turned off.
5. **Shrink the implement prompt** to consume the library.
6. **Add `target` to findings, and the routing.**
7. **Gate checks for asset provenance.**

Steps 1 to 5 ship on their own and already fix the main problem: assets stop
being sculpted by hand inside implement rounds. Steps 6 and 7 are what keep it
from sliding back.

---

## 9. Spike results — the crop step (2026-09-02)

Tool at `docs/spikes/crop.py`, 228 lines, Python stdlib plus PIL. Run against
the real Dark Souls stills in `engine-test/reference/`. Three subcommands:
`grid` overlays a labelled grid on a still, `cut` takes a cell range or a pixel
box, `probe` shells out to the skill's own `probe_image.py`.

**It works, and it takes two passes.** The loop is: overlay a grid, the agent
names cells, cut, the agent looks at the crop, adjusts, accept. The knight in
`ds-steam-1.jpg` came out clipped at the left arm on the first try; `--pad 70`
fixed it, and the second crop is a clean single-figure object reference. Two
iterations, both cheap — they operate on an image, not on a pipeline pass.

**The grid overlay is what makes it reliable.** A vision model names "B3:D8"
accurately and guesses pixel coordinates badly. At 12×8 on a 1920×1080 still
each cell is 160×135 px, fine enough to aim with and coarse enough to name.

**The finding that changed the tool: `probe_image.py` passes crops the rubric
rejects.** Ask for the knight's helmet — a 160×140 box — and the obvious move
is to widen it until it clears the 512 px floor. It then probes `pass` with
zero warnings while the helmet occupies **8.5%** of the frame. That is the
rubric's top reject line, "a scene, not an object reference", wearing a green
tick. The tool now measures `fillRatio` and refuses below 0.25, naming the two
honest options: crop from a still where the object is bigger, or pass
`--allow-upscale` and accept invented pixels.

| Case | Result |
|---|---|
| knight, `B3:D8 --pad 70` | 620×950, fill 0.66 — accepted |
| creature, `E2:I7` | 800×810, fill 1.00 — technically clean, **rubric reject** |
| helmet, `--box 400,300,560,440` | refused, fill 0.085 |
| helmet, `--allow-upscale` | 585×512, upscaled ×3.66 |
| bonfire, `ds-bonfire.png` | 512×512, fill 0.71 — barely needed cropping |

**Upscaling is honest for macro and meso, useless for micro.** The ×3.66
helmet is soft, but the dome, the brim band, the neck flare and the material
class all read — which is the level a procedural rebuild actually needs.
Rivets and edge wear do not survive, so the tool tells the agent to record low
detail confidence in the spec rather than pretending.

**Some cast entries have no usable crop anywhere in the pack.** The creature
crops to 800×810 at fill 1.00 and passes every technical check, and it is still
a reject: the body is cut off, the wings leave the frame, the tendril mass is
ambiguous against the wall behind it, and a spear and a fire beam cross it.
Combat screenshots do not frame bosses cleanly, and no amount of cropping fixes
that.

Three consequences for the plan:

- **`tools/crop.py` is scaffolded into the workspace**, alongside
  `tools/engine-gate.mjs`, and rewritten every round for the same reason.
- **The cast entry's `stills` being a list is load-bearing**, not a
  convenience. The agent will need other frames.
- **"No usable crop" has to be a legal outcome** that the asset run reports,
  rather than something an agent works around by pushing a bad crop into the
  pipeline. A bad crop poisons every pass downstream of it, and the pipeline
  has no way to notice.

What the spike did **not** need: the skill's SAM2 segmentation adapter. A grid
overlay and an agent that can see were enough.

### 9.1 When the crop fails: escalate, then abandon

The rule is that a crop which cannot clear the bar is abandoned and other
material is used. Following that rule through the pack is what turned up the
most consequential finding in this document.

**The ladder is shorter than it looks, structurally.** Reference-phase step 4
builds `motion/` by running `ffmpeg -vf fps=1` over the downloaded clip
(`prompts.ts:18`). Motion frames are therefore never better than the video, so
those two rungs stand or fall together. That part is read straight off the
prompt and holds regardless of any pack.

**What the measurements do and do not show — a correction.** The clips in
`engine-test` are 640×360, below the 512 px floor on height before any cropping
at all, and `ds-full.mp4` is a YouTube let's-play with burned-in joke captions,
UI popups and title cards. But **that material predates the reference phase**:
`engine-test/reference/` is a flat folder, not the
`reference/<loop>/images|motion|video|journey` layout `scanReferencePack`
expects, and no workspace on this machine has a real pack to check. The
reference prompt asks for `bv*[height<=1080]`, so a real pack's clip may be far
better. Treat the resolution numbers below as a worked example of how bad the
bottom rungs *can* be, not as a measurement of the phase.

Provisional ordering:

| Rung | What it is | Use for assets |
|---|---|---|
| `objects/` | isolated object shots (new, §4.1) | the only reliable source |
| `images/` | 8+ stills, 1920×1080 here | good when the object is well framed |
| `journey/` | Playwright captures | varies |
| `motion/` | `fps=1` over the video | never better than the clip |
| `video/` | a downloaded gameplay clip | last resort; 640×360 with burned-in captions in the one pre-phase example we have |

**The rule works when material exists.** The tendril creature in
`ds-steam-1.jpg` is unusable at any crop. The creature in `ds-steam-5.jpg`
cuts to **1120×945 at fill 1.00** — whole silhouette, all four limbs, the tail
hook, the weapon, materials readable. Abandoning the first frame was right and
the second frame was excellent.

**But the five stills are five different enemies.** Abandoning a frame does not
get you the same object from somewhere else; it gets you a different object.
For a cast entry that appears in exactly one still, there is no next rung — the
pack simply cannot supply it. This argument does not depend on the pre-phase
material: a pack of gameplay scenes, however good, never guarantees a clean view
of every cast member. That is what forces `objects/` upstream in §4.1, and it is
why "no usable crop" has to stay a legal, reported outcome even after that
folder exists.

**Third data point on aiming:** a hand-estimated pixel box for the
`ds-steam-5` creature missed badly; the grid fixed it in one pass. Always the
grid, never pixel guessing.

`tools/crop.py` grew a `sheet` subcommand for the scanning half of this — it
contact-sheets a folder of stills or samples a video, so choosing which frame
holds the object costs one look instead of one look per file.

### 9.2 Measured against a real pack (2026-09-02)

`pacman-with-new-reference` has five genuine reference-phase packs in the
`reference/<loop>/images|motion|journey|video` layout. Everything below is
measured on the richest one, a Pac-Man Championship Edition 2 pack with 24
stills.

**The earlier resolution worry does not survive contact with a real pack.**
Stills are 1920×1080 (12 of them) and 1280×720 (9); motion and journey frames
are 1280×720; both clips are 1280×720. Nothing is 640×360. `motion/` is a
usable rung after all, not a dead one, and the ladder in §9.1 should be read
with that correction.

**The crop guard fires exactly where it should.** The hero Pac-Man close-up in
`ce2-11.jpg` crops at fill 0.918 with no upscaling. A ghost inside a `dx-01.jpg`
maze frame is **1.3%** of the frame and is refused; forced through with
`--allow-upscale` it becomes a ×9.31 smear with no recoverable detail. Same
tool, same rules, a completely different game from the one it was built on.

**But this pack challenges the phase's premise, and that is the real finding.**
The pack's own README names what the visual target is: *"extruded neon walls —
not flat lines... a bright saturated outline, a darker translucent core, and a
subtle inner grid texture... heavy bloom so every wall bleeds light."* Its
per-file notes call out score-ladder popups, shockwave rings, chromatic
sparkle, "READY?" lettering, Pac-Man's glow trail, and how little the camera
moves during calm play. Almost all of it is **rendering, shading, HUD and
motion — not sculptable objects.**

The sculptable cast is Pac-Man (a sphere with a wedge), four ghosts (a capsule
with a scalloped skirt), pellets, and fruit. Running a staged pipeline with
vision-correction loops on a Pac-Man sprite is enormous overkill, and it would
spend a whole phase producing five trivial models while missing everything that
actually makes the game look like the reference.

The pack itself identifies only two object-reference candidates — `ce2-11`
("hero-quality 3D Pac-Man macro... Our Pac model/shader bar") and the
`ce2-01..03` giant voxel boss ghost — and both are already near-isolated hero
shots that need no `objects/` folder to find.

**So `objects/` is right but less universally load-bearing than §4.1 claims.**
Some games stage their own object references; a creature-heavy game like Dark
Souls does not. Keep the folder, drop the assumption that every pack needs it
equally.

**And the asset phase is not universally worth running.** See §4.3 — the
nullable `assetModel` is doing more work than cost measurement.
