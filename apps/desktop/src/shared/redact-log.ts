const REDACTED = '[REDACTED]'

/**
 * Remove credential-shaped values from the projected log/history. Raw CLI
 * streams remain untouched on disk so visibility is preserved without
 * copying authentication material into SQLite or the renderer.
 */
export function redactLogText(text: string): string {
  return text
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, `$1\n${REDACTED}\n$2`)
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|token|basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/((?:[?&]|\b)(?:access_token|refresh_token|api_key|auth_token)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/("[A-Za-z0-9_.-]{0,64}(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id|api[_-]?key|private[_-]?key|credentials|token|secret|cookie|password|passwd)"\s*:\s*")(?:\\.|[^"\\])*(")/gi, `$1${REDACTED}$2`)
    .replace(/('[A-Za-z0-9_.-]{0,64}(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id|api[_-]?key|private[_-]?key|credentials|token|secret|cookie|password|passwd)'\s*:\s*')(?:\\.|[^'\\])*(')/gi, `$1${REDACTED}$2`)
    .replace(/((?:[A-Za-z0-9_.-]{0,64}(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id|api[_-]?key|private[_-]?key|credentials|token|secret|cookie|password|passwd))\s*(?::|=)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&\r\n,;}]+)/gi, `$1${REDACTED}`)
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^:/\s@]+:)[^@\s]+(@)/gi, `$1${REDACTED}$2`)
    .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
}

/** Convert an unknown operational failure into bounded renderer-safe text. */
export function redactedErrorMessage(error: unknown, fallback: string, maxLength = 4_096): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  return redactLogText(raw || fallback).slice(0, maxLength) || fallback
}
