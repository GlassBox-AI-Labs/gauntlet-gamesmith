import type { Verdict } from './loop'

export function buildReferencePrompt(userPrompt: string, referenceDir: string): string {
  return `You own the one-time Reference Study for this game loop. Establish a real, attributable quality target before implementation begins. Do not modify project source and do not delegate to subagents.

<goal>
${userPrompt}
</goal>

Write the complete Reference Pack under ./${referenceDir}; this directory belongs only to this loop.

Protocol:
1. Identify the real AAA game reference(s) named in the goal. Use web search now; never rely on memory. If the goal names no reference, select and document the closest AAA benchmarks for its genre and visual target.
2. Create ./${referenceDir}/images, ./${referenceDir}/motion, and ./${referenceDir}/video. Download at least 8 useful, high-resolution stills spanning important gameplay views, environments, characters, HUD, effects, and lighting. Prefer official media and direct, attributable sources. These are research evidence only and must never ship as game assets.
3. Download a representative ~30-second gameplay clip and extract at least 8 frames into ./${referenceDir}/motion. yt-dlp and ffmpeg are installed; for example: \`yt-dlp --download-sections "*60-90" -f "bv*[height<=1080]" -o "${referenceDir}/video/aaa-gameplay.%(ext)s" "<url>"\`, then \`ffmpeg -i ${referenceDir}/video/aaa-gameplay.<ext> -vf fps=1 ${referenceDir}/motion/aaa-%02d.png\`. If one video fails, try another without spending more than a few minutes on it.
4. VIEW every selected still and motion frame. Write ./${referenceDir}/README.md with a concise visual/game-feel target, what each file demonstrates, and instructions implementers can act on.
5. Write ./${referenceDir}/manifest.json as valid JSON: {"title":"reference title","sources":[{"url":"https://…","file":"images/example.jpg","note":"what it demonstrates"}]}. Include a source entry for every downloaded file.
6. Audit the pack before finishing: README.md, valid manifest.json, 8+ stills, 8+ motion frames, and a gameplay video must all exist. Report what you saved, but do not begin implementation.`
}

export function composeImplementPrompt(
  userPrompt: string,
  round: number,
  verdict: Verdict | null,
  delegationRules: string,
  referenceDir: string,
): string {
  const referenceRule = `Before planning or writing code, read ./${referenceDir}/README.md and VIEW the relevant stills and motion frames in the frozen Reference Pack. Do not replace or redownload them.`
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
