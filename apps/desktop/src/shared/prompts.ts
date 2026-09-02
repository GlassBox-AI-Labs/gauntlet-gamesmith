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
2. Run a deep-research sweep on the reference game — anything related to it, from anywhere on the internet, one angle at a time: (a) official media, press kits, and developer interviews/postmortems; (b) gameplay footage from real players — streams, longplays, speedruns, "first 10 minutes" videos; (c) Reddit threads and forum discussions on what makes the game feel the way it does; (d) professional and player reviews, both praise and complaints; (e) wikis and fan pages for mechanics, levels, enemies, storyline, and dialog. ${researchRules} The final ./${referenceDir}/research.md must capture: the signature qualities players and critics consistently call out, the common criticisms to avoid repeating, and concrete mechanics/level/story details — every claim with its source URL. Add every consulted source to manifest.json (omit "file" for link-only sources).
3. Create ./${referenceDir}/images, ./${referenceDir}/motion, and ./${referenceDir}/video. Download at least 8 useful, high-resolution stills spanning important gameplay views, environments, characters, HUD, effects, and lighting. Prefer official media and direct, attributable sources. These are research evidence only and must never ship as game assets.
4. Download a representative ~30-second gameplay clip and extract at least 8 frames into ./${referenceDir}/motion. yt-dlp and ffmpeg are installed; for example: \`yt-dlp --download-sections "*60-90" -f "bv*[height<=1080]" -o "${referenceDir}/video/aaa-gameplay.%(ext)s" "<url>"\`, then \`ffmpeg -i ${referenceDir}/video/aaa-gameplay.<ext> -vf fps=1 ${referenceDir}/motion/aaa-%02d.png\`. If one video fails, try another without spending more than a few minutes on it.
5. Trace the reference game's first-play journey from the very beginning: boot/title screen → main menu and mode selection → intro story or cutscene → the start of Level 1. Hunt for a browser-playable version first: check the official site, itch.io, and the Internet Archive's in-browser emulation library. If the game is playable in a web browser, actually launch and PLAY it yourself. You run inside a macOS sandbox: use Playwright's bundled browsers (\`chromium.launch({ headless: true })\`); never pass \`channel: 'chrome'\` / \`'msedge'\` and never launch an installed browser app — the sandbox blocks it. Capture ordered screenshots into ./${referenceDir}/journey/ named by sequence — 01-title, 02-main-menu, 03-intro, 04-level-1-start — and keep going as far as you can get: dialogs, HUD states, pause/death screens, transitions, level completion. Capture as much dialog and cutscene text as you can, verbatim. If the game cannot be played, extract the same ordered journey shots from attributable video evidence instead and note why.
6. Write ./${referenceDir}/journey.md documenting the walkthrough (main menu → intro → Level 1) with what each journey screenshot shows, and ./${referenceDir}/story.md with the premise, characters, storyline progression, and the dialog you captured.
7. VIEW every selected still and motion frame. Write ./${referenceDir}/README.md with a concise visual/game-feel target, what each file demonstrates, and instructions implementers can act on.
8. Write ./${referenceDir}/manifest.json as valid JSON: {"title":"reference title","sources":[{"url":"https://…","file":"images/example.jpg","note":"what it demonstrates"}]}. Include a source entry for every downloaded file.
9. Audit the pack before finishing: README.md, research.md, journey.md, story.md, valid manifest.json, 8+ stills, 8+ motion frames, 4+ ordered journey shots, and a gameplay video must all exist. Report what you saved, but do not begin implementation.`
}

export function composeImplementPrompt(
  userPrompt: string,
  round: number,
  verdict: Verdict | null,
  delegationRules: string,
  referenceDir: string,
): string {
  const referenceRule = `Before planning or writing code, read ./${referenceDir}/README.md, ./${referenceDir}/journey.md, and ./${referenceDir}/story.md, and VIEW the relevant stills, motion frames, and ordered journey shots in the frozen Reference Pack. Match the documented first-play flow (title → main menu → intro → Level 1) and storyline. Do not replace or redownload the pack.`
  if (round <= 1 || !verdict) return `${userPrompt}\n\n${referenceRule}\n\n${delegationRules}`
  const findings = verdict.findings.map((f) => `- [${f.severity}] ${f.text}`).join('\n')
  return [
    userPrompt,
    '---',
    `A harsh external critic (fresh eyes, a different model) reviewed round ${round - 1}. Score: ${verdict.score.toFixed(2)}/1.00.`,
    `Critic summary: ${verdict.summary}`,
    'Findings you MUST fix this round:',
    findings || '- (no itemized findings — raise overall quality)',
    '---',
    `${referenceRule} Fix every finding above, then keep raising quality toward the bar.`,
    delegationRules,
  ].join('\n\n')
}

export function buildCriticPrompt(userPrompt: string, round: number, referenceDir: string): string {
  const evidenceDir = `critique/round-${round}`
  return `You are a brutally harsh AAA game quality critic with fresh eyes. You did not build this project and you have no attachment to it. Judge the project in the current working directory against this bar:

<goal>
${userPrompt}
</goal>

Protocol:
1. Audit the frozen AAA Reference Pack in ./${referenceDir} FIRST: read its README.md and VIEW its downloaded stills and motion frames. The Reference Study prepared these before implementation so every round uses the same visual bar. Do not redownload or replace it during critique. If the pack is missing or plainly inadequate, record that as a critical process finding and score accordingly; do not substitute memory for evidence.
2. Inspect the project. Install dependencies and build/run it if needed. You may write to the workspace to install, build, serve, or capture screenshots — but do NOT modify project source files and do NOT fix anything yourself.
3. Actually look at the running result whenever possible (serve it, screenshot it with any tooling available). Save every screenshot you capture of this project into ./${evidenceDir}/shots/. ALSO record a short gameplay video (~15-30s of actual play — e.g. Playwright's recordVideo on the served page while simulating input) and save it as ./${evidenceDir}/video/gameplay.webm. Extract frames from your gameplay recording into ./${evidenceDir}/shots/motion/ and compare motion-to-motion against the reference frames: mid-action chaos, trails, feedback timing — not just posed stills. Judge visuals, gameplay, performance, completeness, and polish. You run inside a macOS sandbox: use Playwright's bundled browsers (\`chromium.launch({ headless: true })\`, \`recordVideo\` on the context). Never pass \`channel: 'chrome'\` / \`'msedge'\` and never launch an installed browser app — the sandbox blocks it from registering with macOS, so it aborts on launch and files a crash report.
4. Compare side by side. Copy the specific frozen reference stills and motion frames you compare against into ./${evidenceDir}/refs/. For each comparison pair, judge purely on what is in frame — as if you did not know which image is which — and record every pair TWICE: human-readable notes in ./${evidenceDir}/pairs.md, and machine-readable ./${evidenceDir}/pairs.json — a JSON array of {"shot": "shots/<file>", "ref": "refs/<file>", "winner": "shot"|"ref"|"tie", "why": "<one specific sentence>"}. Be specific about every place this project falls short: textures, lighting, models, animation, physics, audio, UI, game feel.
5. Score 0.00-1.00 where 1.00 = indistinguishable from the AAA reference and 0.90 = you are genuinely wowed. Anything unfinished, ugly, or broken must score low. Do not be polite. Do not grade on effort.

End your reply with EXACTLY one fenced JSON block and nothing after it:

\`\`\`json
{"score": 0.0, "pass": false, "summary": "<=60 words", "findings": [{"severity": "critical|major|minor", "text": "one specific, fixable shortfall"}]}
\`\`\`

"pass" may only be true if score >= 0.90 and you would genuinely mistake screenshots of this game for the AAA reference.`
}
