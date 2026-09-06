import { attemptPromptLabel, type BuildLogLine, type PhaseRole } from '../shared/build'
import { redactLogText } from '../shared/redact-log'

const PROMPT_CHUNK_SIZE = 3_600
const MAX_SYNTHETIC_PROMPT_BYTES = 512 * 1024

export interface PromptLogAttempt {
  id: string
  buildId: string
  round: number
  role: PhaseRole
  prompt: string
  promptComplete?: boolean
  createdAt: string
  startedAt: string | null
}

function projectedPrompt(attempt: PromptLogAttempt, prompt: string): BuildLogLine[] {
  const count = Math.max(1, Math.ceil(prompt.length / PROMPT_CHUNK_SIZE))
  return Array.from({ length: count }, (_, index) => ({
    buildId: attempt.buildId,
    attemptId: attempt.id,
    ts: attempt.startedAt ?? attempt.createdAt,
    kind: 'prompt',
    channel: 'prompt',
    round: attempt.round,
    role: attempt.role,
    text: `${attemptPromptLabel(attempt)}${count > 1 ? ` (${index + 1}/${count})` : ''}:\n${prompt.slice(index * PROMPT_CHUNK_SIZE, (index + 1) * PROMPT_CHUNK_SIZE)}`,
  }))
}

function projectedRawStream(attempt: PromptLogAttempt): BuildLogLine | null {
  if (!attempt.startedAt) return null
  return {
    buildId: attempt.buildId,
    attemptId: attempt.id,
    ts: attempt.startedAt,
    kind: 'raw-stream',
    channel: 'system',
    round: attempt.round,
    role: attempt.role,
    text: 'Raw output stream opened for this attempt.',
  }
}

/**
 * Ensure a bounded log response contains one complete effective prompt per build.
 * A tail query can retain only the final chunk of a long prompt; any partial or
 * legacy projection is replaced from the canonical attempt row rather than being
 * mistaken for a complete prompt.
 */
export function withPromptLogs(attempts: PromptLogAttempt[], source: BuildLogLine[]): BuildLogLine[] {
  let lines = [...source]
  const representedBuilds = new Set(source.flatMap((line) => line.attemptId ? [line.attemptId] : []))
  let remainingBytes = MAX_SYNTHETIC_PROMPT_BYTES
  let omitted = false
  const candidates = attempts.filter((attempt) => attempts.length === 1 || representedBuilds.has(attempt.id))
  if (candidates.length > 64) omitted = true
  // Spend the bounded reconstruction budget on the newest visible attempts.
  for (const attempt of candidates.slice(-64).reverse()) {
    if (attempt.promptComplete === false) {
      omitted = true
      continue
    }
    const prompt = redactLogText(attempt.prompt)
    const count = Math.max(1, Math.ceil(prompt.length / PROMPT_CHUNK_SIZE))
    // Check the aggregate budget before allocating the chunk/event array.
    const projectedBytes = Buffer.byteLength(prompt, 'utf8') + count * 256
    if (projectedBytes > remainingBytes) {
      omitted = true
      continue
    }
    const expected = projectedPrompt(attempt, prompt)
    const existing = lines.filter((line) => line.attemptId === attempt.id && line.kind === 'prompt')
    if (existing.length === expected.length && existing.every((line, index) => line.text === expected[index].text)) continue
    remainingBytes -= projectedBytes

    lines = lines.filter((line) => line.attemptId !== attempt.id || line.kind !== 'prompt')
    const firstAttemptLine = lines.findIndex((line) => line.attemptId === attempt.id)
    lines.splice(firstAttemptLine < 0 ? lines.length : firstAttemptLine, 0, ...expected)
  }
  // Histories launched before raw-stream navigation shipped still get the
  // same event-log-first presentation without mutating their stored history.
  for (const attempt of candidates.slice(-64)) {
    const rawStream = projectedRawStream(attempt)
    if (!rawStream || lines.some((line) => line.attemptId === attempt.id && line.kind === 'raw-stream')) continue
    const firstAttemptLine = lines.findIndex((line) => line.attemptId === attempt.id)
    lines.splice(firstAttemptLine < 0 ? lines.length : firstAttemptLine, 0, rawStream)
  }
  if (omitted && attempts[0]) {
    lines.push({
      buildId: attempts[0].buildId,
      attemptId: null,
      ts: source.at(-1)?.ts ?? attempts[0].createdAt,
      kind: 'system',
      channel: 'system',
      text: 'Some full prompts were omitted from this bounded log response; select a round and use its Prompt browser to inspect the canonical persisted prompt.',
    })
  }
  return lines
}
