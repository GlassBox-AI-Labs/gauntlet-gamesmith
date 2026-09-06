import type { HarnessKind } from '../shared/harness'
import type { TokenTotals } from '../shared/loop'
import { codexTokens } from './codex-usage'
import { rateLimitPause } from './rate-limit'
import { translateClaudeLine } from './streams/claude-stream'
import { translateCodexLine } from './streams/codex-stream'

const MAX_TRACKED_CLAUDE_USAGE_MESSAGES = 2_048
const MAX_STREAM_ID_CHARS = 256

export interface ArtifactPhaseStreamState {
  tokens: TokenTotals
  messages: number
  lastProgressAt: number
  sawUsage: boolean
  failure: string | null
  rateLimitNotice: string | null
  summary: string
  sessionId: string | null
  reportedModel: string | null
}

interface ArtifactPhaseStreamOptions {
  harness: HarnessKind
  phase: 'reference' | 'critique'
  defaultModel: string
  startedAtMs: number
  initialSessionId?: string | null
  now(): number
  log(kind: string, text: string, agentId?: string): void
  onIdentity(sessionId: string | null, model: string | null): void
  onUsage(): void
}

export interface ArtifactPhaseStream {
  onLine(line: string): void
  onStderr(text: string): void
  progressAt(): number
  snapshot(): ArtifactPhaseStreamState
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function trunc(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * One harness-neutral state machine for the two artifact-producing phases.
 * The runner owns transitions; this module owns translation, usage dedupe,
 * rate-limit recognition, identity, and visible raw-event projection.
 */
export function createArtifactPhaseStream(options: ArtifactPhaseStreamOptions): ArtifactPhaseStream {
  const tokens = emptyTokens()
  const usageByMessage = new Map<string, Record<string, number>>()
  let fallbackUsageId = 0
  let messages = 0
  let lastProgressAt = options.startedAtMs
  let sawUsage = false
  let failure: string | null = null
  let rateLimitNotice: string | null = null
  let summary = ''
  let sessionId = options.initialSessionId ?? null
  let reportedModel: string | null = null
  let retentionLimitReported = false

  const visible = (kind: string, text: string, agentId?: string): void => {
    const prefix = options.phase === 'reference' ? '[reference] ' : ''
    options.log(kind, `${prefix}${text}`, agentId)
  }

  const reportRetentionLimit = (): void => {
    if (retentionLimitReported) return
    retentionLimitReported = true
    options.log(
      'error',
      `${options.phase} live accounting reached its ${MAX_TRACKED_CLAUDE_USAGE_MESSAGES}-message projection limit; additional raw events remain on disk and the terminal CLI total remains authoritative.`,
    )
  }

  const replaceClaudeUsage = (): void => {
    tokens.input = 0
    tokens.output = 0
    tokens.cacheRead = 0
    tokens.cacheWrite = 0
    for (const usage of usageByMessage.values()) {
      tokens.input += usage.input_tokens ?? 0
      tokens.output += usage.output_tokens ?? 0
      tokens.cacheRead += usage.cache_read_input_tokens ?? 0
      tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
    }
    messages = usageByMessage.size
  }

  const onClaudeLine = (line: string): void => {
    lastProgressAt = options.now()
    const translated = translateClaudeLine(line)
    if (!translated) return
    if (translated.init) {
      sessionId = translated.init.sessionId ?? sessionId
      reportedModel = translated.init.model ?? reportedModel
      options.onIdentity(sessionId, reportedModel)
      options.log('system', `claude session ${sessionId?.slice(0, 8) ?? '?'} · model ${reportedModel ?? options.defaultModel}`)
    }
    if (translated.usage) {
      sawUsage = true
      const rawId = translated.usage.messageId
      const messageId = rawId && rawId.length <= MAX_STREAM_ID_CHARS ? rawId : `missing-${fallbackUsageId++}`
      if (usageByMessage.has(messageId)) {
        usageByMessage.set(messageId, translated.usage.usage)
        replaceClaudeUsage()
      } else if (usageByMessage.size < MAX_TRACKED_CLAUDE_USAGE_MESSAGES) {
        usageByMessage.set(messageId, translated.usage.usage)
        replaceClaudeUsage()
      } else {
        reportRetentionLimit()
      }
      options.onUsage()
    }
    for (const event of translated.events) visible(event.kind, event.text, event.agentId)
    if (translated.summary !== undefined) summary = translated.summary
    if (translated.result) {
      if (translated.result.text !== null) summary = translated.result.text
      const usage = translated.result.usage
      if (usage) {
        sawUsage = true
        tokens.input = usage.input_tokens ?? tokens.input
        tokens.output = usage.output_tokens ?? tokens.output
        tokens.cacheRead = usage.cache_read_input_tokens ?? tokens.cacheRead
        tokens.cacheWrite = usage.cache_creation_input_tokens ?? tokens.cacheWrite
        messages = Math.max(messages, 1)
      }
      if (translated.result.isError) {
        failure = translated.result.text !== null
          ? trunc(translated.result.text, 400)
          : `claude ${options.phase === 'reference' ? 'reference study' : 'critique'} ${translated.result.subtype ?? 'failed'}`
        if (rateLimitPause(failure, 0)) rateLimitNotice = failure
        options.log('error', failure)
      }
    }
  }

  const onCodexLine = (line: string): void => {
    lastProgressAt = options.now()
    const translated = translateCodexLine(line)
    if (!translated) return
    if (translated.threadStarted !== undefined) {
      sessionId = translated.threadStarted ?? sessionId
      options.onIdentity(sessionId, reportedModel)
      options.log('system', `codex thread ${sessionId?.slice(0, 8) ?? '?'}`)
    }
    for (const event of translated.events) visible(event.kind, event.text, event.agentId)
    if (translated.summary !== undefined) summary = translated.summary
    // A completed turn is proof the CLI got its answer, so anything it reported
    // as an error before that was survived — a dropped websocket it reconnected
    // through, most often. Leaving it set made a recovered transient the run's
    // recorded cause of death half an hour later. A rate-limit notice is
    // deliberately kept: that is a real condition, and clearing it would
    // suppress the account rotation it exists to trigger.
    if (translated.turn) failure = null
    if (translated.turn?.usage) {
      sawUsage = true
      const turn = codexTokens(translated.turn.usage)
      tokens.input += turn.input
      tokens.output += turn.output
      tokens.cacheRead += turn.cacheRead
      tokens.cacheWrite += turn.cacheWrite
      messages += 1
      options.onUsage()
    }
    if (translated.error) {
      failure = translated.error
      if (rateLimitPause(failure, 0)) rateLimitNotice = failure
      options.log('error', failure)
    }
  }

  const snapshot = (): ArtifactPhaseStreamState => ({
    tokens: { ...tokens },
    messages,
    lastProgressAt,
    sawUsage,
    failure,
    rateLimitNotice,
    summary,
    sessionId,
    reportedModel,
  })

  return {
    onLine: options.harness === 'claude' ? onClaudeLine : onCodexLine,
    onStderr: (text) => {
      lastProgressAt = options.now()
      options.log('stderr', trunc(text, 400))
    },
    progressAt: () => lastProgressAt,
    snapshot,
  }
}
