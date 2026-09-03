import { runPromptLabel, type LoopLogLine, type RunRole } from '../shared/loop'
import { redactLogText } from '../shared/redact-log'

const PROMPT_CHUNK_SIZE = 3_600
const MAX_SYNTHETIC_PROMPT_BYTES = 512 * 1024

export interface PromptLogRun {
  id: string
  loopId: string
  round: number
  role: RunRole
  prompt: string
  promptComplete?: boolean
  createdAt: string
  startedAt: string | null
}

function projectedPrompt(run: PromptLogRun, prompt: string): LoopLogLine[] {
  const count = Math.max(1, Math.ceil(prompt.length / PROMPT_CHUNK_SIZE))
  return Array.from({ length: count }, (_, index) => ({
    loopId: run.loopId,
    runId: run.id,
    ts: run.startedAt ?? run.createdAt,
    kind: 'prompt',
    channel: 'prompt',
    round: run.round,
    role: run.role,
    text: `${runPromptLabel(run)}${count > 1 ? ` (${index + 1}/${count})` : ''}:\n${prompt.slice(index * PROMPT_CHUNK_SIZE, (index + 1) * PROMPT_CHUNK_SIZE)}`,
  }))
}

/**
 * Ensure a bounded log response contains one complete effective prompt per run.
 * A tail query can retain only the final chunk of a long prompt; any partial or
 * legacy projection is replaced from the canonical run row rather than being
 * mistaken for a complete prompt.
 */
export function withPromptLogs(runs: PromptLogRun[], source: LoopLogLine[]): LoopLogLine[] {
  let lines = [...source]
  const representedRuns = new Set(source.flatMap((line) => line.runId ? [line.runId] : []))
  let remainingBytes = MAX_SYNTHETIC_PROMPT_BYTES
  let omitted = false
  const candidates = runs.filter((run) => runs.length === 1 || representedRuns.has(run.id))
  if (candidates.length > 64) omitted = true
  // Spend the bounded reconstruction budget on the newest visible attempts.
  for (const run of candidates.slice(-64).reverse()) {
    if (run.promptComplete === false) {
      omitted = true
      continue
    }
    const prompt = redactLogText(run.prompt)
    const count = Math.max(1, Math.ceil(prompt.length / PROMPT_CHUNK_SIZE))
    // Check the aggregate budget before allocating the chunk/event array.
    const projectedBytes = Buffer.byteLength(prompt, 'utf8') + count * 256
    if (projectedBytes > remainingBytes) {
      omitted = true
      continue
    }
    const expected = projectedPrompt(run, prompt)
    const existing = lines.filter((line) => line.runId === run.id && line.kind === 'prompt')
    if (existing.length === expected.length && existing.every((line, index) => line.text === expected[index].text)) continue
    remainingBytes -= projectedBytes

    lines = lines.filter((line) => line.runId !== run.id || line.kind !== 'prompt')
    const firstRunLine = lines.findIndex((line) => line.runId === run.id)
    lines.splice(firstRunLine < 0 ? lines.length : firstRunLine, 0, ...expected)
  }
  if (omitted && runs[0]) {
    lines.push({
      loopId: runs[0].loopId,
      runId: null,
      ts: source.at(-1)?.ts ?? runs[0].createdAt,
      kind: 'system',
      channel: 'system',
      text: 'Some full prompts were omitted from this bounded log response; select a round and use its Prompt browser to inspect the canonical persisted prompt.',
    })
  }
  return lines
}
