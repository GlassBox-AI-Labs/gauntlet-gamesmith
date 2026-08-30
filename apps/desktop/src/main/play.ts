import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { PlayState } from '../shared/loop'

interface PlaySession {
  child: ChildProcess
  state: PlayState
}

const sessions = new Map<string, PlaySession>()

export function playState(loopId: string): PlayState {
  return sessions.get(loopId)?.state ?? { running: false, url: null, error: null }
}

export function stopPlay(loopId: string): void {
  const session = sessions.get(loopId)
  if (!session) return
  sessions.delete(loopId)
  const pid = session.child.pid
  if (!pid) return
  // Negative pid = whole process group (npm spawns the actual dev server).
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3_000).unref()
}

export function stopAllPlay(): void {
  for (const loopId of [...sessions.keys()]) stopPlay(loopId)
}

function detectLaunch(workspaceDir: string): { command: string; args: string[] } | { error: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    for (const script of ['dev', 'start', 'serve', 'preview']) {
      if (pkg.scripts?.[script]) return { command: 'npm', args: ['run', script] }
    }
  } catch {
    /* no package.json — fall through */
  }
  if (fs.existsSync(path.join(workspaceDir, 'index.html'))) return { command: 'npx', args: ['--yes', 'vite'] }
  return { error: 'Nothing launchable yet — no dev/start script and no index.html in the workspace.' }
}

export function startPlay(loopId: string, workspaceDir: string, notify: (state: PlayState & { loopId: string }) => void): PlayState {
  const existing = sessions.get(loopId)
  if (existing?.state.running) {
    if (existing.state.url) void shell.openExternal(existing.state.url)
    return existing.state
  }
  const launch = detectLaunch(workspaceDir)
  if ('error' in launch) return { running: false, url: null, error: launch.error }

  const child = spawn(launch.command, launch.args, {
    cwd: workspaceDir,
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const session: PlaySession = { child, state: { running: true, url: null, error: null } }
  sessions.set(loopId, session)
  const push = (): void => notify({ loopId, ...session.state })

  let buffer = ''
  const scan = (chunk: Buffer): void => {
    if (session.state.url) return
    buffer = (buffer + chunk.toString()).slice(-8_000)
    const match = buffer.replace(/\u001b\[[0-9;]*m/g, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/)
    if (match) {
      session.state.url = match[0]
      void shell.openExternal(match[0])
      push()
    }
  }
  child.stdout?.on('data', scan)
  child.stderr?.on('data', scan)
  child.on('exit', (code) => {
    if (sessions.get(loopId)?.child !== child) return
    sessions.delete(loopId)
    session.state = { running: false, url: null, error: code ? `Game process exited (code ${code}).` : null }
    push()
  })
  child.on('error', (error) => {
    sessions.delete(loopId)
    session.state = { running: false, url: null, error: error.message }
    push()
  })
  push()
  return session.state
}
