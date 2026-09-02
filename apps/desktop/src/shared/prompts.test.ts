import { describe, expect, it } from 'vitest'
import { buildCriticPrompt, buildReferencePrompt, composeImplementPrompt } from './prompts'

const rules = 'Delegate ALL substantial implementation work to implementer agents.'

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
    const prompt = composeImplementPrompt('Build a game like Control', 1, null, rules, 'reference/loop-123')

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
    )

    expect(prompt).toContain('read ./reference/loop-123/README.md')
    expect(prompt).toContain('Flat lighting')
    expect(prompt).not.toContain('yt-dlp')
  })

  it('has critics audit the prepared pack instead of redownloading it every round', () => {
    const prompt = buildCriticPrompt('Build a game like Control', 3, 'reference/loop-123')

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
})
