export function formatPlayExitError(code: number | null, output: string): string {
  const head = code ? `Game process exited (code ${code}).` : 'Game process exited.'
  const detail = output.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (!detail) return head
  const snippet = detail.split('\n').slice(-12).join('\n').slice(-1200)
  return `${head}\n${snippet}`
}

/** Extra flags so a busy 5173 does not kill Play when the config set strictPort. */
export function npmPlayArgs(scriptName: string, scriptBody: string): string[] {
  const args = ['run', scriptName]
  if (/\bvite\b/.test(scriptBody)) args.push('--', '--strictPort', 'false')
  return args
}
