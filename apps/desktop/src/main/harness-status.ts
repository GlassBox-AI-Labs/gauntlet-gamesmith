import type { HarnessDetail, ProbeResult } from '../shared/harness'
import { redactLogText } from '../shared/redact-log'

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

export function parseUrls(value: string): string[] {
  return stripAnsi(value).match(/https?:\/\/[^\s<>"']+/g) ?? []
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 4_096 ? redactLogText(value) : undefined
}

export function parseClaudeStatus(stdout: string, stderr: string, version: string | null): ProbeResult {
  try {
    const raw: unknown = JSON.parse(stdout)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid status response.')
    const status = raw as Record<string, unknown>
    if (typeof status.loggedIn !== 'boolean') throw new Error('Invalid status response.')
    const loggedIn = status.loggedIn
    const authMethod = optionalString(status.authMethod)
    const apiProvider = optionalString(status.apiProvider)
    const subscriptionType = optionalString(status.subscriptionType)
    const details: HarnessDetail[] = []
    const candidates: Array<readonly [string, string | null | undefined]> = [
      ['Version', version == null ? null : redactLogText(version)],
      ['Provider', apiProvider === 'firstParty' ? 'Anthropic API' : apiProvider],
      ['Login method', subscriptionType ? `Claude ${subscriptionType} account` : authMethod],
      ['Organization', optionalString(status.orgName)],
      ['Email', optionalString(status.email)],
    ]
    if (loggedIn) {
      for (const [label, value] of candidates) if (value) details.push([label, value])
    }
    const billingMode: ProbeResult['billingMode'] = !loggedIn
      ? undefined
      : subscriptionType || /claude\.ai|oauth|account/i.test(authMethod ?? '')
        ? 'subscription'
        : /api|key|provider/i.test(`${authMethod ?? ''} ${apiProvider ?? ''}`)
          ? 'api_key'
          : 'unknown'
    return { loggedIn, billingMode, authMethod: loggedIn ? (authMethod ?? 'Claude account') : null, details }
  } catch {
    const message = redactLogText(stripAnsi(stderr || stdout)).trim().slice(0, 4_096)
    return { loggedIn: false, error: /not logged in|not authenticated/i.test(message) ? null : message || null }
  }
}

export function parseCodexStatus(
  ok: boolean,
  stdout: string,
  stderr: string,
  version: string | null,
): ProbeResult {
  const text = redactLogText(stripAnsi(`${stdout}\n${stderr}`)).trim().slice(0, 4_096)
  const loggedIn = ok && /^logged in using\b/i.test(text)
  const auth = text.replace(/^logged in using\s*/i, '') || 'CLI account'
  const billingMode: ProbeResult['billingMode'] = !loggedIn
    ? undefined
    : /chatgpt|subscription|account/i.test(auth)
      ? 'subscription'
      : /api\s*key|api_key/i.test(auth)
        ? 'api_key'
        : 'unknown'
  return {
    loggedIn,
    billingMode,
    authMethod: loggedIn ? auth : null,
    details: loggedIn
      ? [
          ['Version', version == null ? 'Unknown' : redactLogText(version)],
          ['Provider', 'OpenAI'],
          ['Auth', auth],
          ['Credentials', 'Managed privately by Codex CLI'],
        ]
      : [],
    error: loggedIn || /not logged in|not authenticated/i.test(text) ? null : text || null,
  }
}

export function subscriptionAuthError(label: string, status: ProbeResult | null): string | null {
  if (!status?.loggedIn) return `${label} is not connected. Sign in on the Agents tab.`
  if (status.billingMode === 'subscription') return null
  return `${label} is connected with ${status.billingMode === 'api_key' ? 'API-key/provider billing' : 'an unrecognized billing mode'}. Gauntlet Gamesmith only runs subscription-authenticated CLI accounts; sign in with the app-managed subscription profile.`
}
