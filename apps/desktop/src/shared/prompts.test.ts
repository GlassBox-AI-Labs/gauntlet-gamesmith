import { describe, expect, it } from 'vitest'
import { buildCriticPrompt, buildReferencePrompt, composeImplementPrompt } from './prompts'

const rules = 'Delegate ALL substantial implementation work to implementer agents.'
const contract = 'Engine stack (MANDATORY): three@0.185.1, bitecs@0.4.0.'
const gateRules = 'Architecture gate (BLOCKING). Run the gate.'

describe('loop prompts', () => {
  it('gathers a scoped, attributable pack without implementing', () => {
    const prompt = buildReferencePrompt('Build a game like Control', 'reference/loop-123', 'FAN-OUT-RULES')

    expect(prompt).toContain('one-time Reference Study')
    expect(prompt).toContain('./reference/loop-123')
    expect(prompt).toContain('IGDB, MobyGames, or Wikidata')
    expect(prompt).toContain('canonical identity')
    expect(prompt).toContain('at least 8 useful, high-resolution stills')
    expect(prompt).toContain('extract at least 8 frames')
    expect(prompt).toContain('manifest.json')
    expect(prompt).toContain('do not begin implementation')
  })

  it('never redoes work a previous attempt already banked', () => {
    const prompt = buildReferencePrompt('Build a game like Control', 'reference/loop-123', 'FAN-OUT-RULES')

    expect(prompt).toContain('Audit what already exists FIRST')
    expect(prompt).toContain('do NOT redownload or regenerate anything already present and valid')
    expect(prompt).toContain('finish without redoing the research')
  })

  it('sweeps the whole internet for the game and embeds the fan-out rules', () => {
    const prompt = buildReferencePrompt('Build a game like Control', 'reference/loop-123', 'FAN-OUT-RULES')

    expect(prompt).toContain('deep-research sweep')
    expect(prompt).toContain('streams, longplays, speedruns')
    expect(prompt).toContain('Reddit threads and forum discussions')
    expect(prompt).toContain('professional and player reviews')
    expect(prompt).toContain('wikis and fan pages')
    expect(prompt).toContain('FAN-OUT-RULES')
    expect(prompt).toContain('./reference/loop-123/research.md')
    expect(prompt).toContain('Expert gameplay dossier')
    expect(prompt).toContain('advanced player techniques')
    expect(prompt).toContain('difficulty modes and the intended difficulty curve')
    expect(prompt).toContain('classify the reference\'s progression model as level-based or non-level-based')
    expect(prompt).toContain('at least the first three distinct levels/stages/missions')
  })

  it('requires the first-play journey to be traced and documented', () => {
    const prompt = buildReferencePrompt('Build a game like Control', 'reference/loop-123', 'FAN-OUT-RULES')

    expect(prompt).toContain('boot/title screen → main menu and mode selection → intro story or cutscene → the start of Level 1')
    expect(prompt).toContain('If the game is playable in a web browser, actually launch and PLAY it yourself')
    expect(prompt).toContain(`itch.io, and the Internet Archive's in-browser emulation library`)
    expect(prompt).toContain('./reference/loop-123/journey/')
    expect(prompt).toContain('01-title, 02-main-menu, 03-intro, 04-level-1-start')
    expect(prompt).toContain('./reference/loop-123/journey.md')
    expect(prompt).toContain('./reference/loop-123/story.md')
    expect(prompt).toContain('extract the same ordered journey shots from attributable video evidence')
  })

  it('makes the first implementer consume the completed pack', () => {
    const prompt = composeImplementPrompt('Build a game like Control', 1, null, rules, 'reference/loop-123', contract)

    expect(prompt).toContain('read ./reference/loop-123/README.md')
    expect(prompt).toContain('./reference/loop-123/research.md')
    expect(prompt).toContain('./reference/loop-123/journey.md')
    expect(prompt).toContain('./reference/loop-123/story.md')
    expect(prompt).toContain('VIEW the relevant stills, motion frames, and ordered journey shots')
    expect(prompt).toContain('WATCH the gameplay clip')
    expect(prompt).toContain('You are the orchestrator and own the integrated game')
    expect(prompt).toContain('ship at least three complete, distinct, playable levels/stages/missions')
    expect(prompt).toContain('If it classifies the game as non-level-based')
    expect(prompt).toContain('Tune difficulty through actual end-to-end play')
    expect(prompt).toContain('verify the story and difficulty curve in the running game')
    expect(prompt).toContain('Do not replace or redownload the pack')
    expect(prompt).not.toContain('yt-dlp')
  })

  it('makes later implementers reuse the same reference pack', () => {
    const prompt = composeImplementPrompt(
      'Build a game like Control',
      2,
      {
        score: 0.4,
        pass: false,
        summary: 'Needs work',
        findings: [{ severity: 'major', text: 'Flat lighting' }],
      },
      rules,
      'reference/loop-123',
      contract,
    )

    expect(prompt).toContain('read ./reference/loop-123/README.md')
    expect(prompt).toContain('Flat lighting')
    expect(prompt).not.toContain('yt-dlp')
  })

  it('has critics audit the prepared pack instead of redownloading it every round', () => {
    const prompt = buildCriticPrompt('Build a game like Control', 3, 'reference/loop-123', gateRules)

    expect(prompt).toContain('Build your expertise from the frozen AAA Reference Pack in ./reference/loop-123 FIRST')
    expect(prompt).toContain('read README.md, research.md, journey.md, story.md, and manifest.json')
    expect(prompt).toContain('Do not redownload or replace the pack during critique')
    expect(prompt).toContain('record that as a critical process finding')
    expect(prompt).toContain('critique/round-3/shots/')
    expect(prompt).toContain('critique/round-3/refs/')
    expect(prompt).toContain('critique/round-3/test-plan.md')
    expect(prompt).toContain('Actually PLAY the running game like an expert')
    expect(prompt).toContain('complete the full implemented progression')
    expect(prompt).toContain('provoke damage, death, restart, win, pause/resume')
    expect(prompt).toContain('require at least three complete, distinct, playable levels/stages/missions')
    expect(prompt).toContain('test its documented progression model without demanding artificial levels')
  })

  it('demands the verdict as both a file artifact and the entire final message', () => {
    const prompt = buildCriticPrompt('Build a game like Control', 3, 'reference/loop-123', gateRules)

    expect(prompt).toContain('FIRST write ./critique/round-3/verdict.json')
    expect(prompt).toContain('no code fence, no markdown, nothing else in the file')
    expect(prompt).toContain('a critique that skips it is invalid')
    expect(prompt).toContain('Your final message must be NOTHING but the fenced JSON block')
    expect(prompt).toContain('you personally write verdict.json and output the fenced block yourself')
  })

  it('has the Reference Study name the cast and gather isolated object shots', () => {
    const prompt = buildReferencePrompt('Build a soulslike', 'reference/loop-1', 'fan out')
    expect(prompt).toContain('reference/loop-1/cast.md')
    expect(prompt).toContain('reference/loop-1/objects/')
    // A cast is objects only. The things a shader draws are not entries.
    expect(prompt).toContain('bloom, score popups, glow trails')
    expect(prompt).toContain('that is a real answer and not a failure')
    // Cropping belongs downstream, where a rejected crop can be retried.
    expect(prompt).toContain('Do NOT record crop boxes or pixel coordinates')
  })

  it('tells the implementer to wire the library up rather than sculpt or edit it', () => {
    const prompt = composeImplementPrompt('Build it', 1, null, rules, 'reference/loop-1', contract)
    expect(prompt).toContain('./src/assets/<name>.ts')
    expect(prompt).toContain('WIRE THEM UP, not to sculpt')
    expect(prompt).toContain('Do NOT hand-edit a generated factory')
    // A phase that could not build something must not silently lose it.
    expect(prompt).toContain('model that one yourself')
  })

  it('keeps the asset contract in front of later rounds too', () => {
    const verdict = { score: 0.4, pass: false, summary: 'thin', findings: [{ severity: 'major', text: 'flat' }] }
    expect(composeImplementPrompt('Build it', 3, verdict, rules, 'reference/loop-1', contract)).toContain('Do NOT hand-edit a generated factory')
  })
})

const cast = [
  { name: 'samoyed', kind: 'character', stills: ['objects/samoyed-01.jpg'], locator: 'front left', role: 'the player' },
  { name: 'wolf', kind: 'creature', stills: ['images/still-2.jpg'], locator: 'centre', role: 'chases the player' },
]

describe('sculpting inside the implement prompt', () => {
  it('leaves the wire-up-only text untouched when nothing needs sculpting', () => {
    const withDefault = composeImplementPrompt('Build it', 1, null, rules, 'reference/loop-1', contract)
    const withEmpty = composeImplementPrompt('Build it', 1, null, rules, 'reference/loop-1', contract, [])
    expect(withEmpty).toBe(withDefault)
    expect(withDefault).not.toContain('Sculpt these BEFORE wiring anything up')
  })

  it('lists what still needs a sculptor before the wire-up instructions', () => {
    const prompt = composeImplementPrompt('Build a soulslike', 1, null, rules, 'reference/loop-1', contract, cast)
    expect(prompt).toContain('Sculpt these BEFORE wiring anything up')
    expect(prompt).toContain('`samoyed` (character) — front left')
    expect(prompt).toContain('`wolf` (creature) — centre')
    expect(prompt.indexOf('Sculpt these BEFORE')).toBeLessThan(prompt.indexOf('WIRE THEM UP'))
  })

  it('still tells the orchestrator to hand each one to its own sculptor and never force a bad crop', () => {
    const prompt = composeImplementPrompt('Build a soulslike', 1, null, rules, 'reference/loop-1', contract, cast)
    expect(prompt).toContain('Hand each to its own sculptor, in parallel')
    expect(prompt).toContain('tools/crop.py')
    expect(prompt).toContain('abandon a bad crop rather than force it through')
    // Source order matters: isolated shots first, the derived clip last.
    expect(prompt.indexOf('reference/loop-1/objects/')).toBeLessThan(prompt.indexOf('`video/`'))
  })

  it('keeps the wire-up and unbuildable-fallback text after the sculpt list', () => {
    const prompt = composeImplementPrompt('Build a soulslike', 1, null, rules, 'reference/loop-1', contract, cast)
    expect(prompt).toContain('WIRE THEM UP, not to sculpt')
    expect(prompt).toContain('Do NOT hand-edit a generated factory')
    expect(prompt).toContain('model that one yourself')
  })
})

describe('critic routing', () => {
  it('sends model faults back to the pipeline and everything else to the implementer', () => {
    const prompt = buildCriticPrompt('Build it', 2, 'reference/loop-1', gateRules)
    expect(prompt).toContain('"target": "game"')
    expect(prompt).toContain('asset:<name>')
    expect(prompt).toContain('When unsure, use `game`')
  })

  it('lets the critic read object shots but never judge the game against them', () => {
    const prompt = buildCriticPrompt('Build it', 2, 'reference/loop-1', gateRules)
    expect(prompt).toContain('reference/loop-1/objects/')
    expect(prompt).toContain('NEVER copy one into ./critique/round-2/refs/')
    expect(prompt).toContain('Pairs are gameplay-to-gameplay only')
  })
})

describe('the engine contract inside the reference-study prompts', () => {
  it('reaches the first implementer alongside the reference pack', () => {
    const prompt = composeImplementPrompt('Build a game like Control', 1, null, rules, 'reference/loop-123', contract)

    expect(prompt).toContain(contract)
  })

  it('is repeated on later rounds, and says not to trade it away for a finding', () => {
    const prompt = composeImplementPrompt(
      'Build a game like Control',
      7,
      { score: 0.4, pass: false, summary: 'Needs work', findings: [{ severity: 'major', text: 'Flat lighting' }] },
      rules,
      'reference/loop-123',
      contract,
    )

    expect(prompt).toContain(contract)
    expect(prompt).toContain('Never fix a finding by weakening the engine contract')
  })

  it('makes the gate block a critic pass, not merely cost score', () => {
    const prompt = buildCriticPrompt('Build a game like Control', 3, 'reference/loop-123', gateRules)

    expect(prompt).toContain(gateRules)
    expect(prompt).toContain('`node tools/engine-gate.mjs` exited 0')
  })
})
