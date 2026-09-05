import { useEffect, useState } from 'react'
import {
  Check,
  KeyRound,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Route,
  Sparkles,
  SquareTerminal,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { TerminalPanel } from '@/components/TerminalPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useHarnessConnections } from '@/lib/use-harness-connections'
import {
  HARNESS_LABELS,
  harnessKinds,
  PRIMARY_ACCOUNT_ID,
  type AccountsResult,
  type AccountsState,
  type HarnessAccount,
  type HarnessKind,
  type LoginPhase,
} from '../../../shared/harness'

type AccountMap = Record<HarnessKind, AccountsState>

const noAccounts: AccountsState = { activeId: PRIMARY_ACCOUNT_ID, accounts: [] }

function accountLabel(account: HarnessAccount): string {
  const until = account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN
  if (!Number.isFinite(until) || until <= Date.now()) return account.label
  const clock = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${account.label} — limit resets ~${clock}`
}

/** The command the login button runs, mirroring harnessSpec in the main process. */
const LOGIN_COMMAND: Record<HarnessKind, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  grok: 'grok login',
}

const HARNESS_GLYPH: Record<HarnessKind, React.JSX.Element> = {
  claude: <Sparkles />,
  codex: <span className="grid size-4 place-items-center rounded-full border text-[10px]">◎</span>,
  grok: <span className="grid size-4 place-items-center rounded-full border text-[10px]">✕</span>,
}

const phaseLabels: Record<LoginPhase, string> = {
  checking: 'Checking…',
  not_found: 'CLI not found',
  installing: 'Installing the CLI',
  logged_out: 'Not connected',
  signing_in: 'Running login',
  awaiting_browser: 'Finish in browser',
  logged_in: 'Connected',
  signing_out: 'Signing out',
  error: 'Login failed',
}

function StatusDot({ phase }: { phase: LoginPhase }): React.JSX.Element {
  if (
    phase === 'checking'
    || phase === 'installing'
    || phase === 'signing_in'
    || phase === 'awaiting_browser'
    || phase === 'signing_out'
  ) {
    return <LoaderCircle className="size-3.5 animate-spin text-[#b5afac]" />
  }
  return (
    <span
      className={`size-2 rounded-full ${
        phase === 'logged_in' ? 'bg-emerald-400' : phase === 'error' || phase === 'not_found' ? 'bg-red-400' : 'bg-[#68615f]'
      }`}
    />
  )
}

export function AgentsView({ onReplayTour }: { onReplayTour?: () => void }): React.JSX.Element {
  const { states: state, dispatch, transcripts, registerWriter, clearTranscript, probe } = useHarnessConnections()
  const [activeKind, setActiveKind] = useState<HarnessKind>('claude')
  const [actionBusy, setActionBusy] = useState(false)
  const [terminalStarted, setTerminalStarted] = useState<Record<HarnessKind, boolean>>(
    () => Object.fromEntries(harnessKinds.map((kind) => [kind, false])) as Record<HarnessKind, boolean>,
  )
  const [accounts, setAccounts] = useState<AccountMap>(
    () => Object.fromEntries(harnessKinds.map((kind) => [kind, noAccounts])) as AccountMap,
  )
  const [accountError, setAccountError] = useState<Record<HarnessKind, string | null>>(
    () => Object.fromEntries(harnessKinds.map((kind) => [kind, null])) as Record<HarnessKind, string | null>,
  )
  const [replaying, setReplaying] = useState(false)

  useEffect(() => {
    const removeAccountListener = window.harnesses.onAccountsChanged((kind) => {
      void window.harnesses.accounts(kind)
        .then((list) => setAccounts((current) => ({ ...current, [kind]: list })))
        .catch(() => undefined)
      void window.harnesses.probe(kind)
        .then((result) => dispatch({ kind, action: { type: 'probe_finished', ...result } }))
        .catch(() => undefined)
    })
    void Promise.all(
      harnessKinds.map(async (kind) => {
        try {
          const list = await window.harnesses.accounts(kind)
          setAccounts((current) => ({ ...current, [kind]: list }))
        } catch {
          // The harness hook already surfaces detection and login failures.
        }
      }),
    )

    return () => {
      removeAccountListener()
    }
  }, [dispatch])

  const harness = state[activeKind]
  const running = harness.phase === 'signing_in' || harness.phase === 'awaiting_browser'
  const checking = harness.phase === 'checking'
  const signingOut = harness.phase === 'signing_out'
  const account = accounts[activeKind]
  const accountsLocked = actionBusy || running || signingOut
  const terminalVisible = running || (harness.phase === 'logged_in' && terminalStarted[activeKind])

  const startLogin = async (): Promise<void> => {
    if (actionBusy) return
    setActionBusy(true)
    clearTranscript(activeKind)
    setTerminalStarted((current) => ({ ...current, [activeKind]: true }))
    try {
      await window.harnesses.startLogin(activeKind)
    } catch (error) {
      dispatch({
        kind: activeKind,
        action: { type: 'login_failed', error: error instanceof Error ? error.message : 'Unable to start login.' },
      })
    } finally {
      setActionBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    if (actionBusy) return
    setActionBusy(true)
    try {
      await probe(activeKind)
    } catch (error) {
      dispatch({
        kind: activeKind,
        action: { type: 'login_failed', error: error instanceof Error ? error.message : 'Unable to refresh login status.' },
      })
    } finally {
      setActionBusy(false)
    }
  }

  const loadAccounts = async (kind: HarnessKind): Promise<void> => {
    const list = await window.harnesses.accounts(kind)
    setAccounts((current) => ({ ...current, [kind]: list }))
  }

  const reprobe = async (): Promise<void> => {
    clearTranscript(activeKind)
    setTerminalStarted((current) => ({ ...current, [activeKind]: false }))
    await probe(activeKind)
    await loadAccounts(activeKind)
  }

  const applyAccounts = (result: AccountsResult): boolean => {
    setAccounts((current) => ({ ...current, [activeKind]: result.state }))
    setAccountError((current) => ({ ...current, [activeKind]: result.error ?? null }))
    return result.ok
  }

  const runAccountChange = async (change: () => Promise<AccountsResult>): Promise<void> => {
    if (actionBusy) return
    setActionBusy(true)
    try {
      if (applyAccounts(await change())) await reprobe()
    } catch (error) {
      setAccountError((current) => ({
        ...current,
        [activeKind]: error instanceof Error ? error.message : 'Unable to change accounts.',
      }))
    } finally {
      setActionBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    if (actionBusy) return
    setActionBusy(true)
    dispatch({ kind: activeKind, action: { type: 'logout_started' } })
    try {
      const result = await window.harnesses.logout(activeKind)
      if (!result.ok) {
        dispatch({ kind: activeKind, action: { type: 'logout_failed', error: result.error ?? 'Unable to sign out.' } })
        return
      }
      await reprobe()
    } catch (error) {
      dispatch({
        kind: activeKind,
        action: { type: 'logout_failed', error: error instanceof Error ? error.message : 'Unable to sign out.' },
      })
    } finally {
      setActionBusy(false)
    }
  }

  /** Puts the first-run flow back and hands the screen over to it. */
  const replayTour = async (): Promise<void> => {
    if (replaying) return
    setReplaying(true)
    try {
      await window.onboarding.reset()
    } catch {
      // The flow is still worth showing even if the flag could not be cleared;
      // it will simply not persist as unfinished.
    } finally {
      setReplaying(false)
      onReplayTour?.()
    }
  }

  const cancelLogin = async (): Promise<void> => {
    if (actionBusy) return
    setActionBusy(true)
    try {
      await window.harnesses.cancelLogin(activeKind)
    } catch (error) {
      dispatch({
        kind: activeKind,
        action: { type: 'login_failed', error: error instanceof Error ? error.message : 'Unable to cancel login.' },
      })
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <main className="mx-auto w-[min(980px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">
      <h1 className="mb-11 text-[27px] font-semibold tracking-[-0.02em]">Agents</h1>

      <Tabs value={activeKind} onValueChange={(value) => setActiveKind(value as HarnessKind)}>
        <TabsList variant="line" className="h-auto w-full justify-start gap-7 border-b border-[#2a2626] p-0">
          {harnessKinds.map((kind) => (
            <TabsTrigger
              key={kind}
              value={kind}
              className="flex-none gap-2 rounded-none border-0 bg-transparent px-0 pb-3 text-[15px] shadow-none after:bg-[#e9c9bc] data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent"
            >
              {HARNESS_GLYPH[kind]} {HARNESS_LABELS[kind]}
              {state[kind].phase === 'logged_in' && <span className="size-1.5 rounded-full bg-emerald-400" />}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <h2 className="mb-4 mt-7 text-[17px] font-semibold">Authentication</h2>
      <div className="grid grid-cols-2 gap-3.5 max-sm:grid-cols-1">
        <Card className="relative grid h-[132px] place-content-center justify-items-center gap-2 border-[#393433] bg-[#2b2826] py-0 shadow-none">
          <Check className="absolute right-4 top-3.5 size-4" />
          <SquareTerminal className="size-7" />
          <span className="text-sm font-medium">CLI</span>
        </Card>
        <Card className="relative grid h-[132px] place-content-center justify-items-center gap-2 border-[#332e2e] bg-transparent py-0 text-[#9c9693] shadow-none">
          <Badge className="absolute right-2.5 top-2.5 bg-[#735d59] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[#e0d5d0]">Later</Badge>
          <KeyRound className="size-7" />
          <span className="text-sm font-medium">API key</span>
        </Card>
      </div>

      <h2 className="mb-4 mt-7 text-[17px] font-semibold">Account</h2>
      <div className="flex items-center gap-2.5 max-sm:flex-wrap">
        <Select
          value={account.accounts.some((entry) => entry.id === account.activeId) ? account.activeId : undefined}
          onValueChange={(value) => {
            if (value !== account.activeId) void runAccountChange(() => window.harnesses.switchAccount(activeKind, value))
          }}
          disabled={accountsLocked || account.accounts.length === 0}
        >
          <SelectTrigger className="w-[300px] max-sm:w-full">
            <SelectValue placeholder="No accounts" />
          </SelectTrigger>
          <SelectContent>
            {account.accounts.map((entry) => <SelectItem key={entry.id} value={entry.id}>{accountLabel(entry)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" className="text-[#b5afac] hover:bg-white/5 hover:text-white" disabled={accountsLocked} onClick={() => void runAccountChange(() => window.harnesses.addAccount(activeKind))}>
          <UserPlus /> Add account
        </Button>
        {account.activeId !== PRIMARY_ACCOUNT_ID && (
          <Button variant="ghost" className="text-[#b5afac] hover:bg-white/5 hover:text-white" disabled={accountsLocked} onClick={() => void runAccountChange(() => window.harnesses.removeAccount(activeKind, account.activeId))}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
      <p className="mt-2.5 text-xs text-[#7d7772]">
        Accounts share run history. A usage-limited run rotates to the next available account and retries automatically.
      </p>
      {onReplayTour && <Button
        variant="ghost"
        className="mt-3 text-[#b5afac] hover:bg-white/5 hover:text-white"
        disabled={replaying}
        onClick={() => void replayTour()}
      >
        {replaying ? <LoaderCircle className="animate-spin" /> : <Route />} Show the tour again
      </Button>}
      {accountError[activeKind] && <p className="mt-3 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{accountError[activeKind]}</p>}

      <div className="my-7 flex items-center gap-2.5">
        <StatusDot phase={harness.phase} />
        <strong className="text-sm font-medium">{phaseLabels[harness.phase]}</strong>
        {(harness.phase === 'logged_in' || signingOut) && (
          <Button variant="ghost" className="ml-auto text-[#b5afac] hover:bg-white/5 hover:text-white" disabled={signingOut || actionBusy} onClick={() => void signOut()}>
            <LogOut /> Sign out
          </Button>
        )}
        <Button
          variant="ghost"
          className={`${harness.phase === 'logged_in' || signingOut ? '' : 'ml-auto'} text-[#b5afac] hover:bg-white/5 hover:text-white`}
          disabled={!harness.found || running || signingOut || checking || actionBusy}
          onClick={() => void refresh()}
        >
          <RefreshCw className={checking ? 'animate-spin' : ''} /> {checking ? 'Checking…' : 'Refresh'}
        </Button>
      </div>

      {harness.details.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[#332e2e]">
          <Table>
            <TableBody>
              {harness.details.map(([label, value]) => (
                <TableRow key={label} className="border-[#3b3636] hover:bg-transparent">
                  <TableCell className="w-[150px] bg-[#171313] px-3.5 py-3 text-[#96908d]">{label}</TableCell>
                  <TableCell className="px-3.5 py-3 text-[#ded9d6]">{value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {harness.error && (
        <p className="mt-4 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{harness.error}</p>
      )}

      {!terminalVisible && (
        <Button
          variant="outline"
          className="mt-5 border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white"
          disabled={!harness.found || actionBusy}
          onClick={() => void startLogin()}
        >
          {actionBusy ? <LoaderCircle className="animate-spin" /> : <Play className="fill-current" />} Run {LOGIN_COMMAND[activeKind]}
        </Button>
      )}

      {terminalVisible && (
        <TerminalPanel
          kind={activeKind}
          phase={harness.phase}
          transcript={transcripts.current[activeKind]}
          onCancel={() => void cancelLogin()}
          onClose={() => setTerminalStarted((current) => ({ ...current, [activeKind]: false }))}
          registerWriter={registerWriter}
        />
      )}
    </main>
  )
}
