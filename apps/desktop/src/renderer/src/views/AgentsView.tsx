import { useEffect, useReducer, useRef, useState } from 'react'
import {
  Check,
  KeyRound,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
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
import { initialHarnessState, reduceHarness } from '@/lib/login-state'
import type {
  AccountsResult,
  AccountsState,
  HarnessAccount,
  HarnessAction,
  HarnessKind,
  HarnessState,
  LoginPhase,
} from '../../../shared/harness'
import { PRIMARY_ACCOUNT_ID } from '../../../shared/harness'

type HarnessMap = Record<HarnessKind, HarnessState>
type AccountMap = Record<HarnessKind, AccountsState>

const noAccounts: AccountsState = { activeId: PRIMARY_ACCOUNT_ID, accounts: [] }

/** A spent account is still listed, but says when it is worth trying again. */
function accountLabel(account: HarnessAccount): string {
  const until = account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN
  if (!Number.isFinite(until) || until <= Date.now()) return account.label
  const clock = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${account.label} — limit resets ~${clock}`
}
type StateEvent = { kind: HarnessKind; action: HarnessAction }

const phaseLabels: Record<LoginPhase, string> = {
  checking: 'Checking…',
  not_found: 'CLI not found',
  logged_out: 'Not connected',
  signing_in: 'Running login',
  awaiting_browser: 'Finish in browser',
  logged_in: 'Connected',
  signing_out: 'Signing out…',
  error: 'Login failed',
}

const initialState: HarnessMap = {
  claude: initialHarnessState('claude', 'Claude Code'),
  codex: initialHarnessState('codex', 'Codex'),
}

function stateReducer(state: HarnessMap, event: StateEvent): HarnessMap {
  return { ...state, [event.kind]: reduceHarness(state[event.kind], event.action) }
}

function StatusDot({ phase }: { phase: LoginPhase }): React.JSX.Element {
  if (phase === 'checking' || phase === 'signing_in' || phase === 'awaiting_browser' || phase === 'signing_out') {
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

export function AgentsView(): React.JSX.Element {
  const [state, dispatch] = useReducer(stateReducer, initialState)
  const [activeKind, setActiveKind] = useState<HarnessKind>('claude')
  const [terminalStarted, setTerminalStarted] = useState<Record<HarnessKind, boolean>>({
    claude: false,
    codex: false,
  })
  const [accounts, setAccounts] = useState<AccountMap>({ claude: noAccounts, codex: noAccounts })
  const [accountError, setAccountError] = useState<Record<HarnessKind, string | null>>({ claude: null, codex: null })
  const [accountBusy, setAccountBusy] = useState(false)
  const transcripts = useRef<Record<HarnessKind, string>>({ claude: '', codex: '' })
  const terminalWriters = useRef<Partial<Record<HarnessKind, (data: string) => void>>>({})

  useEffect(() => {
    const removeLoginListener = window.harnesses.onLoginEvent((event) => dispatch(event))
    // A run that hits a usage limit changes accounts by itself, so the tab has
    // to follow rather than show the account that was active a moment ago.
    const removeAccountListener = window.harnesses.onAccountsChanged((kind) => {
      void window.harnesses.accounts(kind).then((list) => setAccounts((current) => ({ ...current, [kind]: list })))
      void window.harnesses.probe(kind).then((probe) => dispatch({ kind, action: { type: 'probe_finished', ...probe } }))
    })
    const removeTerminalListener = window.harnesses.onTerminalData(({ kind, data }) => {
      transcripts.current[kind] = `${transcripts.current[kind]}${data}`.slice(-32_000)
      terminalWriters.current[kind]?.(data)
    })

    void Promise.all(
      (['claude', 'codex'] as const).map(async (kind) => {
        const detection = await window.harnesses.detect(kind)
        dispatch({ kind, action: { type: 'detected', ...detection } })
        if (detection.found) {
          const probe = await window.harnesses.probe(kind)
          dispatch({ kind, action: { type: 'probe_finished', ...probe } })
        }
        // Read the list after the probe: a signed-in account is renamed to its
        // email as a side effect of the status check.
        const list = await window.harnesses.accounts(kind)
        setAccounts((current) => ({ ...current, [kind]: list }))
      }),
    )

    return () => {
      removeLoginListener()
      removeAccountListener()
      removeTerminalListener()
    }
  }, [])

  const harness = state[activeKind]
  const running = harness.phase === 'signing_in' || harness.phase === 'awaiting_browser'
  const signingOut = harness.phase === 'signing_out'
  const account = accounts[activeKind]
  const accountsLocked = accountBusy || running || signingOut
  const terminalVisible = running || (harness.phase === 'logged_in' && terminalStarted[activeKind])

  const startLogin = async (): Promise<void> => {
    transcripts.current[activeKind] = ''
    setTerminalStarted((current) => ({ ...current, [activeKind]: true }))
    try {
      await window.harnesses.startLogin(activeKind)
    } catch (error) {
      dispatch({
        kind: activeKind,
        action: { type: 'login_failed', error: error instanceof Error ? error.message : 'Unable to start login.' },
      })
    }
  }

  /** Sign the CLI out so the next login can use a different account. */
  const signOut = async (): Promise<void> => {
    dispatch({ kind: activeKind, action: { type: 'logout_started' } })
    try {
      const result = await window.harnesses.logout(activeKind)
      if (!result.ok) {
        dispatch({
          kind: activeKind,
          action: { type: 'logout_failed', error: result.error ?? 'Unable to sign out.' },
        })
        return
      }
    } catch (error) {
      dispatch({
        kind: activeKind,
        action: { type: 'logout_failed', error: error instanceof Error ? error.message : 'Unable to sign out.' },
      })
      return
    }
    transcripts.current[activeKind] = ''
    setTerminalStarted((current) => ({ ...current, [activeKind]: false }))
    const probe = await window.harnesses.probe(activeKind)
    dispatch({ kind: activeKind, action: { type: 'probe_finished', ...probe } })
  }

  const loadAccounts = async (kind: HarnessKind): Promise<void> => {
    const list = await window.harnesses.accounts(kind)
    setAccounts((current) => ({ ...current, [kind]: list }))
  }

  /** Re-read the status of whichever account is now active. */
  const reprobe = async (): Promise<void> => {
    transcripts.current[activeKind] = ''
    setTerminalStarted((current) => ({ ...current, [activeKind]: false }))
    dispatch({ kind: activeKind, action: { type: 'probe_started' } })
    const probe = await window.harnesses.probe(activeKind)
    dispatch({ kind: activeKind, action: { type: 'probe_finished', ...probe } })
    await loadAccounts(activeKind)
  }

  const applyAccounts = (result: AccountsResult): boolean => {
    setAccounts((current) => ({ ...current, [activeKind]: result.state }))
    setAccountError((current) => ({ ...current, [activeKind]: result.error ?? null }))
    return result.ok
  }

  const runAccountChange = async (change: () => Promise<AccountsResult>): Promise<void> => {
    setAccountBusy(true)
    try {
      if (applyAccounts(await change())) await reprobe()
    } catch (error) {
      setAccountError((current) => ({
        ...current,
        [activeKind]: error instanceof Error ? error.message : 'Unable to change accounts.',
      }))
    } finally {
      setAccountBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    dispatch({ kind: activeKind, action: { type: 'probe_started' } })
    const probe = await window.harnesses.probe(activeKind)
    dispatch({ kind: activeKind, action: { type: 'probe_finished', ...probe } })
  }

  return (
    <main className="mx-auto w-[min(980px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">
      <h1 className="mb-11 text-[27px] font-semibold tracking-[-0.02em]">Agents</h1>

      <Tabs value={activeKind} onValueChange={(value) => setActiveKind(value as HarnessKind)}>
        <TabsList variant="line" className="h-auto w-full justify-start gap-7 border-b border-[#2a2626] p-0">
          <TabsTrigger
            value="claude"
            className="flex-none gap-2 rounded-none border-0 bg-transparent px-0 pb-3 text-[15px] shadow-none after:bg-[#e9c9bc] data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent"
          >
            <Sparkles /> Claude Code
            {state.claude.phase === 'logged_in' && <span className="size-1.5 rounded-full bg-emerald-400" />}
          </TabsTrigger>
          <TabsTrigger
            value="codex"
            className="flex-none gap-2 rounded-none border-0 bg-transparent px-0 pb-3 text-[15px] shadow-none after:bg-[#e9c9bc] data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent"
          >
            <span className="grid size-4 place-items-center rounded-full border text-[10px]">◎</span> Codex
            {state.codex.phase === 'logged_in' && <span className="size-1.5 rounded-full bg-emerald-400" />}
          </TabsTrigger>
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
            {account.accounts.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {accountLabel(entry)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          className="text-[#b5afac] hover:bg-white/5 hover:text-white"
          disabled={accountsLocked}
          onClick={() => void runAccountChange(() => window.harnesses.addAccount(activeKind))}
        >
          <UserPlus /> Add account
        </Button>
        {account.activeId !== PRIMARY_ACCOUNT_ID && (
          <Button
            variant="ghost"
            className="text-[#b5afac] hover:bg-white/5 hover:text-white"
            disabled={accountsLocked}
            onClick={() =>
              void runAccountChange(() => window.harnesses.removeAccount(activeKind, account.activeId))
            }
          >
            <Trash2 /> Remove
          </Button>
        )}
      </div>
      <p className="mt-2.5 text-xs text-[#7d7772]">
        Accounts share run history, so a switch keeps the session a run resumes from. Switching by hand needs the loop
        stopped; a run that hits a usage limit changes account and retries on its own.
      </p>

      {accountError[activeKind] && (
        <p className="mt-3 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">
          {accountError[activeKind]}
        </p>
      )}

      <div className="my-7 flex items-center gap-2.5">
        <StatusDot phase={harness.phase} />
        <strong className="text-sm font-medium">{phaseLabels[harness.phase]}</strong>
        {(harness.phase === 'logged_in' || signingOut) && (
          <Button
            variant="ghost"
            className="ml-auto text-[#b5afac] hover:bg-white/5 hover:text-white"
            disabled={signingOut}
            onClick={() => void signOut()}
          >
            <LogOut /> Sign out
          </Button>
        )}
        <Button
          variant="ghost"
          className={`text-[#b5afac] hover:bg-white/5 hover:text-white ${
            harness.phase === 'logged_in' || signingOut ? '' : 'ml-auto'
          }`}
          disabled={!harness.found || running || signingOut}
          onClick={() => void refresh()}
        >
          <RefreshCw /> Refresh
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
          disabled={!harness.found || signingOut}
          onClick={() => void startLogin()}
        >
          <Play className="fill-current" /> Run {activeKind === 'claude' ? 'claude auth login' : 'codex login'}
        </Button>
      )}

      {terminalVisible && (
        <TerminalPanel
          kind={activeKind}
          phase={harness.phase}
          transcript={transcripts.current[activeKind]}
          onCancel={() => void window.harnesses.cancelLogin(activeKind)}
          onClose={() => setTerminalStarted((current) => ({ ...current, [activeKind]: false }))}
          registerWriter={(kind, writer) => {
            if (writer) terminalWriters.current[kind] = writer
            else delete terminalWriters.current[kind]
          }}
        />
      )}
    </main>
  )
}
