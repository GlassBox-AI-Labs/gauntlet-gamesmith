import type { Verdict } from './loop'

export function buildReferencePrompt(userPrompt: string, referenceDir: string, researchRules: string): string {
  return `You own the one-time Reference Study for this game loop. Establish a real, attributable quality target before implementation begins. Do not modify project source. However the research is gathered, you alone assemble, distill, and validate the final pack.

<goal>
${userPrompt}
</goal>

Write the complete Reference Pack under ./${referenceDir}; this directory belongs only to this loop.

This may be a retry: a previous attempt may have left a partial or even complete pack in that directory. Audit what already exists FIRST — keep every usable file, do NOT redownload or regenerate anything already present and valid, and spend your effort only on what is missing or broken. If the pack already passes the audit in the final step, verify it and finish without redoing the research.

Protocol:
1. Identify the real AAA game reference(s) named in the goal. Use web search now; never rely on memory. Resolve each reference against an authoritative game catalog — IGDB, MobyGames, or Wikidata — and record its canonical identity: exact title, developer, release year, platforms, and genre. Put that identity at the top of research.md and use the canonical title as manifest.json's "title". If the goal names no reference, browse those catalogs by genre and visual target, select the closest AAA benchmarks, and document why.
2. Run a deep-research sweep on the reference game — anything related to it, from anywhere on the internet, one angle at a time: (a) official media, manuals, control guides, press kits, and developer interviews/postmortems; (b) gameplay footage from real players — expert runs, high-difficulty play, streams, longplays, speedruns, and "first 10 minutes" videos; (c) Reddit threads and forum discussions on what makes the game feel the way it does; (d) professional and player reviews, both praise and complaints; (e) wikis and fan pages for mechanics, levels, enemies, bosses, storyline, and dialog. ${researchRules} The final ./${referenceDir}/research.md is the critic's source of game expertise, not just a mood board. Give it an "Expert gameplay dossier" that documents the controls; primary and secondary gameplay loops; signature mechanics and advanced player techniques; resources, scoring, upgrades, enemies, bosses, fail/win states, exploits and edge cases; difficulty modes and the intended difficulty curve; and the tests an expert player would use to expose a weak imitation. Explicitly classify the reference's progression model as level-based or non-level-based. If it is level-based, identify at least the first three distinct levels/stages/missions and document each one's mechanics, enemies, difficulty escalation, story beat, and completion condition. Also capture the signature qualities players and critics consistently call out, the common criticisms to avoid repeating, and concrete mechanics/level/story details — every claim with its source URL. Add every consulted source to manifest.json (omit "file" for link-only sources).
3. Create ./${referenceDir}/images, ./${referenceDir}/motion, and ./${referenceDir}/video. Download at least 8 useful, high-resolution stills spanning important gameplay views, environments, characters, HUD, effects, and lighting. Prefer official media and direct, attributable sources. These are research evidence only and must never ship as game assets.
4. Download a representative ~30-second gameplay clip and extract at least 8 frames into ./${referenceDir}/motion. yt-dlp and ffmpeg are installed; for example: \`yt-dlp --download-sections "*60-90" -f "bv*[height<=1080]" -o "${referenceDir}/video/aaa-gameplay.%(ext)s" "<url>"\`, then \`ffmpeg -i ${referenceDir}/video/aaa-gameplay.<ext> -vf fps=1 ${referenceDir}/motion/aaa-%02d.png\`. If one video fails, try another without spending more than a few minutes on it.
5. Trace the reference game's first-play journey from the very beginning: boot/title screen → main menu and mode selection → intro story or cutscene → the start of Level 1. Hunt for a browser-playable version first: check the official site, itch.io, and the Internet Archive's in-browser emulation library. If the game is playable in a web browser, actually launch and PLAY it yourself: exercise every control you can reach, deliberately fail and restart, try the signature mechanics, and record observed timing, rules, difficulty, and progression in research.md. You run inside a macOS sandbox: use Playwright's bundled browsers (\`chromium.launch({ headless: true })\`); never pass \`channel: 'chrome'\` / \`'msedge'\` and never launch an installed browser app — the sandbox blocks it. Capture ordered screenshots into ./${referenceDir}/journey/ named by sequence — 01-title, 02-main-menu, 03-intro, 04-level-1-start — and keep going as far as you can get: dialogs, HUD states, pause/death screens, transitions, level completion, and later levels. Capture as much dialog and cutscene text as you can, verbatim. If the game cannot be played, extract the same ordered journey shots from attributable video evidence, derive the gameplay observations from sourced footage, and note why direct play was impossible.
6. Write ./${referenceDir}/journey.md documenting the walkthrough (main menu → intro → Level 1 and onward) with what each journey screenshot shows, and ./${referenceDir}/story.md with the premise, characters, full storyline progression, level-to-level story beats, ending or resolution, and the dialog you captured.
7. VIEW every selected still and motion frame and WATCH the downloaded gameplay clip. Write ./${referenceDir}/README.md with a concise visual/game-feel target, what each file demonstrates, and instructions implementers can act on. It must state \`Progression model: level-based\` or \`Progression model: non-level-based\`. For a level-based reference it must also state that the implementation requires at least three complete, distinct, playable levels/stages/missions; for a non-level-based reference, name the equivalent progression structure instead of inventing levels.
8. Name the cast: every distinct OBJECT the game is made of that a 3D model would have to exist for — characters, creatures, props, structures, plants. Judge only what is an object. A maze's extruded neon walls, bloom, score popups, glow trails, particle bursts and HUD numerals are rendering and motion, not objects; leave them out. If the game genuinely has no sculptable objects, write \`none\` in cast.md and skip to the next step — that is a real answer and not a failure. Write ./${referenceDir}/cast.md describing each one in prose, and put the machine-readable list in manifest.json under a "cast" array: [{"name":"kebab-case-slug","kind":"character|creature|prop|structure|flora","stills":["images/ce2-11.jpg"],"locator":"where in the frame it is, e.g. the white dog, front left","role":"what it does in play, what it collides with, what attaches to it","priority":1}]. Name at least one frame per entry where the object is actually visible, best view first, and keep "locator" specific enough to tell two similar creatures apart. Do NOT record crop boxes or pixel coordinates — cutting the object out is a later phase's job.
9. Gather object reference into ./${referenceDir}/objects/ — clean, isolated shots of the named cast, one object per image, from wikis, official art, bestiary pages, model viewers and press kits. Gameplay stills are scenes: they rarely frame any single object well enough to rebuild it, and a boss that only ever appears mid-fight has no usable view at all. Name each file after the cast slug (objects/samoyed-01.jpg) and attribute it in manifest.json like everything else. Get what you can and move on: a missing object shot makes a weaker pack, not a failed one.
10. Audit the pack before finishing: README.md, research.md (including the Expert gameplay dossier and progression classification), journey.md, story.md, cast.md, valid manifest.json, 8+ stills, 8+ motion frames, 4+ ordered journey shots, and a gameplay video must all exist. Report what you saved, but do not begin implementation.`
}

export function composeImplementPrompt(
  userPrompt: string,
  round: number,
  verdict: Verdict | null,
  delegationRules: string,
  referenceDir: string,
  engineContract: string,
): string {
  const assetRule = `Assets — the Asset Build phase has already sculpted the game's models into ./src/assets/<name>.ts, one procedural factory per cast entry, each returning a \`THREE.Group\` carrying \`userData.sculptRuntime\` (nodes, sockets, colliders) and \`userData.rig\`. Your job is to WIRE THEM UP, not to sculpt: call each factory ONCE, extract what it carries into a plain record, and spawn cheaply from that — calling a factory per enemy is the mistake that eats the frame budget. Read ./${referenceDir}/cast.md for what each model is and how it behaves in play. Do NOT hand-edit a generated factory: if a model needs a different collider, socket or scale, say so in your report and it is regenerated. If ./src/assets is empty or a cast entry has no factory — the phase reports entries it could not build — model that one yourself and say which in your report.`
  const referenceRule = `Before planning, delegating, or writing code, read ./${referenceDir}/README.md, ./${referenceDir}/research.md, ./${referenceDir}/journey.md, and ./${referenceDir}/story.md; VIEW the relevant stills, motion frames, and ordered journey shots; and WATCH the gameplay clip in the frozen Reference Pack. Treat the Expert gameplay dossier in research.md as the authority for controls, mechanics, advanced techniques, enemies, fail/win states, difficulty, and progression — do not substitute memory. Do not replace or redownload the pack.

You are the orchestrator and own the integrated game, not just its build. Before delegating, turn the Reference Study into explicit acceptance criteria for story, gameplay, difficulty, and progression, then include the relevant criteria and exact reference files in every worker brief. Match the documented first-play flow and story arc. Tune difficulty through actual end-to-end play so challenge escalates deliberately, mechanics are taught before they are tested, failure is fair and recoverable, and no difficulty spike or trivial exploit breaks the curve. If the Reference Study classifies the game as level-based, ship at least three complete, distinct, playable levels/stages/missions with real transitions, escalating mechanics and difficulty, story progression, and reachable completion states; menus, reskins, empty rooms, and placeholders do not count. If it classifies the game as non-level-based, preserve its documented progression structure instead of inventing levels. Do not finish after a build-only check: play the full implemented progression, verify every required level or milestone is reachable and completable, and verify the story and difficulty curve in the running game.`
  if (round <= 1 || !verdict) return `${userPrompt}\n\n${referenceRule}\n\n${engineContract}\n\n${assetRule}\n\n${delegationRules}`
  const findings = verdict.findings.map((f) => `- [${f.severity}] ${f.text}`).join('\n')
  return [
    userPrompt,
    '---',
    `A harsh external critic (fresh eyes, a different model) reviewed round ${round - 1}. Score: ${verdict.score.toFixed(2)}/1.00.`,
    `Critic summary: ${verdict.summary}`,
    'Findings you MUST fix this round:',
    findings || '- (no itemized findings — raise overall quality)',
    '---',
    `${referenceRule} Fix every finding above, then keep raising quality toward the bar. Never fix a finding by weakening the engine contract below — if one genuinely conflicts with it, say so in your report and fix the rest.`,
    engineContract,
    assetRule,
    delegationRules,
  ].join('\n\n')
}

/**
 * How many sculptors the Asset Build runs at once.
 *
 * Width sets the burn rate, not the total: the same cast costs about the same
 * whether it is built four at a time or all at once. What a narrow wave buys
 * is a bounded loss. A sculptor banks its work only by finishing — it writes
 * `src/assets/<name>.ts` and its evidence at the end — so everything still in
 * flight when a usage limit ends the run is gone. One run launched 27 at once,
 * banked 8 in a six-minute burst, then hit the wall: the other 19 left no
 * crops, no zone analysis, no blockouts, nothing to resume from.
 */
export const ASSET_WAVE_SIZE = 4

/**
 * The Asset Build.
 *
 * One run that fans out: the orchestrator reads the cast and hands the entries
 * to sculptors in waves, because assets are independent of one another and the
 * runner drives one process per loop. `only` is the re-entrant case — a later
 * round rebuilding just what the critic faulted.
 */
export function buildAssetsPrompt(
  userPrompt: string,
  referenceDir: string,
  cast: { name: string; kind: string; stills: string[]; locator: string; role: string }[],
  sculptorRules: string,
  only: string[] = [],
): string {
  const wanted = only.length > 0 ? cast.filter((entry) => only.includes(entry.name)) : cast
  const list = wanted
    .map((entry) => `- \`${entry.name}\` (${entry.kind}) — ${entry.locator || 'see cast.md'}. Plays as: ${entry.role || 'see cast.md'}. Frames: ${entry.stills.join(', ') || 'none named; search the pack'}`)
    .join('\n')
  const scope =
    only.length > 0
      ? `This is a REBUILD round. Only these entries are in scope — every other model in ./src/assets is finished and must not be touched:`
      : `Build every entry in the cast:`
  return `You own the Asset Build for this game loop. You produce the game's 3D models and nothing else: no gameplay, no rendering, no HUD, no level code. Do not touch ./src outside ./src/assets.

<goal>
${userPrompt}
</goal>

${scope}

${list || '(the cast is empty — report that and finish without building anything)'}

Protocol:
1. Read ./${referenceDir}/cast.md and ./${referenceDir}/README.md so you know what each model is and how it behaves in play.
2. Hand the entries out one sculptor each, in waves of at most ${ASSET_WAVE_SIZE} at a time. Wait for a wave to report before launching the next. Do NOT launch the whole cast at once: sculptors share no files, so a wide fan-out is tempting, but a sculptor only banks its work by finishing, and a usage limit that lands mid-wave throws away everything still in flight. Four at a time is what caps that loss. ${sculptorRules}
3. Every sculptor works from a CROP, never a whole gameplay still. \`tools/crop.py\` is in the workspace: \`sheet\` contact-sheets a stills folder or samples a video, \`grid\` overlays a labelled grid on a still, \`cut\` takes a grid range (\`--cells B3:D8\`) or a pixel box. Aim by naming grid cells; guessing pixel coordinates does not work. Crops belong in \`.img2threejs/<name>/crop/\` and NEVER in ./${referenceDir}, which is frozen.
4. Source order, best first: \`${referenceDir}/objects/\` (isolated shots — always try these first), then \`images/\`, \`journey/\`, \`motion/\`, \`video/\`. If a crop cannot be made good — the object is a smear, or half of it is out of frame — ABANDON that frame and try another. A bad crop poisons every later pass and nothing downstream can notice. If every source fails, report that entry as unbuildable and move on; do not force a bad crop through, and do not invent a model from memory.
5. Check each wave as it lands, not just at the end: verify every finished entry actually wrote ./src/assets/<name>.ts and left its evidence under \`.img2threejs/<name>/\` before the next wave goes out. Run \`npx tsc --noEmit\` if a tsconfig exists, and fix nothing yourself — send a broken factory back to its sculptor.
6. Finish with a plain report: which entries were built, which were unbuildable and why, and which source each model was cut from. Do not begin implementation.`
}

export function buildCriticPrompt(userPrompt: string, round: number, referenceDir: string, engineGateRules: string): string {
  const evidenceDir = `critique/round-${round}`
  return `You are a brutally harsh AAA game critic and an expert playtester of the specific reference game. Your expertise must come from the frozen Reference Study, not from memory or generic genre assumptions. You did not build this project and you have no attachment to it. Judge the project in the current working directory against this bar:

<goal>
${userPrompt}
</goal>

Protocol:
1. Build your expertise from the frozen AAA Reference Pack in ./${referenceDir} FIRST: read README.md, research.md, journey.md, story.md, and manifest.json; VIEW its downloaded stills, motion frames, and ordered journey shots; and WATCH its gameplay video. Use research.md's sourced Expert gameplay dossier as your authority for controls, gameplay loops, advanced techniques, systems, enemies, bosses, difficulty, progression, fail/win states, and known edge cases. Do not redownload or replace the pack during critique. If the dossier or pack is missing, unsourced, or plainly inadequate, record that as a critical process finding and score accordingly; do not fill gaps from memory.
2. Before inspecting the implementation, write ./${evidenceDir}/test-plan.md from that dossier. It must name the reference-specific mechanics and expert techniques you will execute, the story and difficulty beats you will verify, every available level or progression milestone you will reach, and the failure/edge cases you will provoke. For a level-based reference, require at least three complete, distinct, playable levels/stages/missions; if fewer exist or later ones are reskins/placeholders, make that a critical finding. For a non-level-based reference, test its documented progression model without demanding artificial levels.
3. Inspect the project. Install dependencies and build/run it if needed. You may write to the workspace to install, build, serve, play, or capture evidence — but do NOT modify project source files and do NOT fix anything yourself.
4. Actually PLAY the running game like an expert, not a screenshot tourist. Use the real controls and complete the full implemented progression. Exercise every reference-signature mechanic and advanced technique you can; try aggressive, defensive, and resource-starved play; test each enemy or obstacle pattern; provoke damage, death, restart, win, pause/resume, boundary/collision, rapid/repeated input, and transition states; and try the known exploits and edge cases from the dossier. Verify that the story is coherent in play and that challenge teaches, escalates, and remains fair. For level-based games, play all required levels and prove each is distinct, reachable, and completable. If automation cannot reach something, report the exact blocker and do not credit the feature merely because its code or menu exists.
5. Save every screenshot you capture of this project into ./${evidenceDir}/shots/. ALSO record gameplay video covering representative expert play and progression (~30-60s, or multiple clips when needed — e.g. Playwright's recordVideo on the served page while simulating real input) and save it under ./${evidenceDir}/video/. Extract frames from your gameplay recording into ./${evidenceDir}/shots/motion/ and compare motion-to-motion against the reference frames: mid-action chaos, trails, feedback timing — not just posed stills. Judge visuals, story, gameplay depth, controls, difficulty curve, level design, performance, completeness, and polish. You run inside a macOS sandbox: use Playwright's bundled browsers (\`chromium.launch({ headless: true })\`, \`recordVideo\` on the context). Never pass \`channel: 'chrome'\` / \`'msedge'\` and never launch an installed browser app — the sandbox blocks it from registering with macOS, so it aborts on launch and files a crash report.
6. Compare side by side. Copy the specific frozen reference stills and motion frames you compare against into ./${evidenceDir}/refs/. You may READ ./${referenceDir}/objects/ to learn what a thing is supposed to look like, the same way you read research.md, but NEVER copy one into ./${evidenceDir}/refs/ or cite one in pairs.json: those are isolated studio shots, so judging a gameplay screenshot against one scores the marketing rather than the game and breaks the blind comparison. Pairs are gameplay-to-gameplay only — stills, motion frames, and journey shots. For each comparison pair, judge purely on what is in frame — as if you did not know which image is which — and record every pair TWICE: human-readable notes in ./${evidenceDir}/pairs.md, and machine-readable ./${evidenceDir}/pairs.json — a JSON array of {"shot": "shots/<file>", "ref": "refs/<file>", "winner": "shot"|"ref"|"tie", "why": "<one specific sentence>"}. Be specific about every place this project falls short: textures, lighting, models, animation, physics, audio, UI, game feel.
7. Score 0.00-1.00 where 1.00 = indistinguishable from the AAA reference and 0.90 = you are genuinely wowed by both presentation and expert play. Anything unfinished, ugly, shallow, unbalanced, broken, story-incoherent, or missing required progression must score low. Do not be polite. Do not grade on effort or code that you could not demonstrate in play.
8. ${engineGateRules}
9. Deliver the verdict twice. FIRST write ./${evidenceDir}/verdict.json containing exactly this object as plain valid JSON — no code fence, no markdown, nothing else in the file:

{"score": 0.0, "pass": false, "summary": "<=60 words", "findings": [{"severity": "critical|major|minor", "text": "one specific, fixable shortfall", "target": "game"}]}

Set "target" on every finding. Use \`asset:<name>\` — the cast slug from ./${referenceDir}/cast.md — when the fault is the MODEL itself: wrong shape, wrong proportions, wrong materials, reads as the wrong thing. That sends it back through the sculpting pipeline for that one model. Use \`game\` for everything else, including how a model is used: placement, animation, lighting, scale in the scene, or how it feels to play against. When unsure, use \`game\`.

THEN end your reply with EXACTLY one fenced JSON block containing the same object:

\`\`\`json
{"score": 0.0, "pass": false, "summary": "<=60 words", "findings": [{"severity": "critical|major|minor", "text": "one specific, fixable shortfall", "target": "game"}]}
\`\`\`

Verdict rules, non-negotiable: writing ./${evidenceDir}/verdict.json is a required protocol step, not bookkeeping — a critique that skips it is invalid no matter how thorough the report. Your final message must be NOTHING but the fenced JSON block: no lead-in summary, no closing remarks, no text after it. If you delegated any part of the critique to a subagent, its report does not satisfy either requirement — after reading its findings, you personally write verdict.json and output the fenced block yourself. "pass" may only be true if score >= 0.90, \`node tools/engine-gate.mjs\` exited 0, the required story/progression/difficulty checks pass, and you would genuinely mistake both screenshots and gameplay of this game for the AAA reference.`
}
