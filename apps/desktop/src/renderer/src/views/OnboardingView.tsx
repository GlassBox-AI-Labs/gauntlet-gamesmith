import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Download, LoaderCircle, Play, Sparkles, TriangleAlert } from 'lucide-react'
import { TerminalPanel } from '@/components/TerminalPanel'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useHarnessConnections } from '@/lib/use-harness-connections'
import {
  ONBOARDING_STEPS,
  STEP_TITLES,
  TOUR_CARDS,
  canLeaveConnectStep,
  connectFooterNote,
  connectStatus,
  connectStatusLabel,
  connectStepSettled,
  connectedHarness,
  nextStep,
  previousStep,
  stepIndex,
  type OnboardingStep,
} from '@/lib/onboarding-steps'
import { HARNESS_LABELS, harnessKinds, type HarnessKind, type HarnessState, type InstallOffer } from '../../../shared/harness'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function StepDots({ step }: { step: OnboardingStep }): React.JSX.Element {
  const current = stepIndex(step)
  return (
    <ol className="flex items-center gap-2" aria-label="Setup progress">
      {ONBOARDING_STEPS.map((entry, index) => (
        <li
          key={entry}
          aria-current={entry === step ? 'step' : undefined}
          className="flex items-center gap-2 text-[11px] text-[#7d7772]"
        >
          <span
            className={`size-1.5 rounded-full ${index <= current ? 'bg-[#e9c9bc]' : 'bg-[#3b3636]'}`}
            aria-hidden="true"
          />
          <span className={entry === step ? 'text-[#ded9d6]' : 'sr-only'}>{STEP_TITLES[entry]}</span>
        </li>
      ))}
    </ol>
  )
}

function InstallHint({ kind, offer, busy, onInstall }: {
  kind: HarnessKind
  offer: InstallOffer | null
  busy: boolean
  onInstall: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const command = offer?.command ?? null

  const copy = async (): Promise<void> => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setCopied(false)
    }
  }

  if (!offer) {
    return (
      <p className="mt-3 text-xs text-[#96908d]">
        <LoaderCircle className="mr-1.5 inline size-3 animate-spin" aria-hidden="true" />
        Checking how to install it…
      </p>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-[#3b3636] bg-[#171313] p-3">
      {offer.available
        ? (
          <>
            <p className="text-xs leading-relaxed text-[#96908d]">
              The app can install it for you. It downloads and runs {HARNESS_LABELS[kind]}&apos;s official
              installer, which needs no other software, and shows you everything it does.
            </p>
            <Button
              variant="outline"
              className="mt-3 border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white"
              disabled={busy}
              onClick={onInstall}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Download />} Install {HARNESS_LABELS[kind]}
            </Button>
          </>
        )
        : (
          <p className="text-xs leading-relaxed text-[#96908d]">
            Installing from the app is only supported on macOS and Linux. Open a terminal, paste this
            line, and press return. Then come back and press Refresh.
          </p>
        )}

      {command && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-[#7d7772] hover:text-[#b5afac]">
            {offer.available ? 'Show the exact command' : 'The command to run'}
          </summary>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-[#0e0c0c] px-2.5 py-2 font-mono text-[11px] text-[#ded9d6]">
              {command}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-[#b5afac] hover:bg-white/5 hover:text-white"
              aria-label={`Copy the ${HARNESS_LABELS[kind]} install command`}
              onClick={() => void copy()}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          {copied && <p className="mt-1.5 text-[11px] text-emerald-300">Copied.</p>}
        </details>
      )}
    </div>
  )
}

interface AgentCardProps {
  state: HarnessState
  offer: InstallOffer | null
  selected: boolean
  busy: boolean
  onSelect: () => void
  onSignIn: () => void
  onInstall: () => void
  onRefresh: () => void
}

function AgentCard({ state, offer, selected, busy, onSelect, onSignIn, onInstall, onRefresh }: AgentCardProps): React.JSX.Element {
  const status = connectStatus(state)
  const label = HARNESS_LABELS[state.kind]

  return (
    <Card
      className={`gap-0 border py-0 shadow-none ${
        selected ? 'border-[#6d5a55] bg-[#2b2826]' : 'border-[#332e2e] bg-transparent'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-center gap-3 rounded-t-xl px-4 py-3.5 text-left hover:bg-white/[0.03]"
      >
        {state.kind === 'claude'
          ? <Sparkles className="size-5 shrink-0" aria-hidden="true" />
          : <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full border text-[11px]">◎</span>}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-[#eeeae7]">{label}</span>
          <span className="flex items-center gap-1.5 text-xs text-[#96908d]">
            {(status === 'checking' || status === 'installing') && (
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            )}
            {status === 'connected' && <Check className="size-3 text-emerald-400" aria-hidden="true" />}
            {(status === 'blocked' || status === 'failed') && (
              <TriangleAlert className="size-3 text-amber-400" aria-hidden="true" />
            )}
            {connectStatusLabel(state)}
          </span>
        </span>
      </button>

      <div className="px-4 pb-4">
        {status === 'blocked' && (
          <>
            <InstallHint kind={state.kind} offer={offer} busy={busy} onInstall={onInstall} />
            <Button
              variant="ghost"
              className="mt-2 text-[#b5afac] hover:bg-white/5 hover:text-white"
              disabled={busy}
              onClick={onRefresh}
            >
              Refresh
            </Button>
          </>
        )}
        {status === 'installing' && (
          <p className="text-xs text-[#96908d]">Installing. The output is below; this takes a minute.</p>
        )}
        {(status === 'ready' || status === 'failed') && (
          <Button
            variant="outline"
            className="border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white"
            disabled={busy}
            onClick={onSignIn}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Play className="fill-current" />}
            Sign in to {label}
          </Button>
        )}
        {status === 'connected' && (
          <p className="text-xs text-[#7d7772]">Ready to use. You can add more accounts later on the Agents tab.</p>
        )}
      </div>
    </Card>
  )
}

/**
 * The first-run flow: say what the app is, get one agent signed in, explain the
 * loop, then hand over to the Runs view.
 *
 * Finishing is recorded in the main process, so the flow does not come back
 * after a restart. It is skippable on purpose — someone reinstalling should not
 * have to sit through it.
 */
export function OnboardingView({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { states, dispatch, transcripts, registerWriter, clearTranscript, probe } = useHarnessConnections()
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [selected, setSelected] = useState<HarnessKind>('claude')
  const [offers, setOffers] = useState<Partial<Record<HarnessKind, InstallOffer>>>({})
  const [busy, setBusy] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = states[selected]
  const signingIn = active.phase === 'signing_in' || active.phase === 'awaiting_browser'
  const installing = active.phase === 'installing'
  const connected = connectedHarness(states)

  useEffect(() => {
    let disposed = false
    void Promise.all(harnessKinds.map(async (kind) => {
      try {
        const offer = await window.harnesses.installOffer(kind)
        if (!disposed) setOffers((current) => ({ ...current, [kind]: offer }))
      } catch {
        // Without an offer the card shows the missing-CLI message with no
        // install button, which is the correct conservative fallback.
        if (!disposed) setOffers((current) => ({ ...current, [kind]: { available: false, command: null } }))
      }
    }))
    return () => { disposed = true }
  }, [])

  const finish = async (): Promise<void> => {
    if (finishing) return
    setFinishing(true)
    try {
      await window.onboarding.complete(connected)
    } catch {
      // Losing the flag only means the flow runs again next launch. Trapping
      // someone in setup because a file would not write is the worse failure.
    } finally {
      setFinishing(false)
      onDone()
    }
  }

  const startLogin = async (kind: HarnessKind): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    clearTranscript(kind)
    try {
      await window.harnesses.startLogin(kind)
    } catch (cause) {
      dispatch({ kind, action: { type: 'login_failed', error: errorMessage(cause, 'Unable to start login.') } })
    } finally {
      setBusy(false)
    }
  }

  const startInstall = async (kind: HarnessKind): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setSelected(kind)
    clearTranscript(kind)
    try {
      await window.harnesses.startInstall(kind)
    } catch (cause) {
      dispatch({ kind, action: { type: 'install_failed', error: errorMessage(cause, 'Unable to start the installer.') } })
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (kind: HarnessKind): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const detection = await window.harnesses.detect(kind)
      dispatch({ kind, action: { type: 'detected', ...detection } })
      if (detection.found) await probe(kind)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not check for the agent.'))
    } finally {
      setBusy(false)
    }
  }

  const cancelLogin = async (kind: HarnessKind): Promise<void> => {
    try {
      await window.harnesses.cancelLogin(kind)
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to cancel login.'))
    }
  }

  const goNext = (): void => {
    const upcoming = nextStep(step)
    if (upcoming) setStep(upcoming)
    else void finish()
  }

  const goBack = (): void => {
    const earlier = previousStep(step)
    if (earlier) setStep(earlier)
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-[#2a2626] bg-[#100d0e]/90 backdrop-blur">
        <div className="mx-auto flex w-[min(760px,calc(100%-48px))] items-center justify-between py-3 max-sm:w-[calc(100%-28px)]">
          <StepDots step={step} />
          <Button
            variant="ghost"
            className="text-[#7d7772] hover:bg-white/5 hover:text-white"
            disabled={finishing}
            onClick={() => void finish()}
          >
            Skip setup
          </Button>
        </div>
      </header>

      <main className="mx-auto w-[min(760px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">
        {step === 'welcome' && (
          <section>
            <h1 className="text-[27px] font-semibold tracking-[-0.02em]">Welcome to Gauntlet Gamesmith</h1>
            <p className="mt-4 text-sm leading-relaxed text-[#b5afac]">
              This app builds small browser games for you. You describe the game you want. The app then
              looks up real reference material, writes the game, criticizes its own work, and tries
              again — round after round — until the criticism stops or you tell it to stop.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-[#b5afac]">
              It does that work through a coding agent you already pay for, running on this machine with
              your own sign-in. Setting that up is the next step, and it takes about a minute.
            </p>
            <div className="mt-7 rounded-lg border border-[#332e2e] bg-[#171313] p-4">
              <h2 className="text-sm font-medium text-[#ded9d6]">Everything stays on your computer</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[#96908d]">
                There is no account to create and no server to connect to. The app starts each agent's
                own sign-in and reads whether it worked. It never reads, copies, or sends your login.
              </p>
            </div>
          </section>
        )}

        {step === 'connect' && (
          <section>
            <h1 className="text-[27px] font-semibold tracking-[-0.02em]">Connect an agent</h1>
            <p className="mt-4 text-sm leading-relaxed text-[#b5afac]">
              Pick the one you have a subscription for. One is enough. Signing in opens that agent's own
              login in a small terminal below, which usually sends you to your browser to confirm.
            </p>

            <div className="mt-7 grid gap-3.5">
              {harnessKinds.map((kind) => (
                <AgentCard
                  key={kind}
                  state={states[kind]}
                  offer={offers[kind] ?? null}
                  selected={selected === kind}
                  busy={busy || signingIn || installing}
                  onSelect={() => setSelected(kind)}
                  onSignIn={() => void startLogin(kind)}
                  onInstall={() => void startInstall(kind)}
                  onRefresh={() => void refresh(kind)}
                />
              ))}
            </div>

            {error && (
              <p className="mt-4 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">
                {error}
              </p>
            )}

            {(signingIn || installing) && (
              <div className="mt-5">
                <TerminalPanel
                  kind={selected}
                  phase={active.phase}
                  transcript={transcripts.current[selected]}
                  onCancel={() => void cancelLogin(selected)}
                  onClose={() => void cancelLogin(selected)}
                  registerWriter={registerWriter}
                />
              </div>
            )}

            <p className="mt-6 text-xs text-[#7d7772]">
              {connectStepSettled(states) ? connectFooterNote(states) : 'Checking what is installed…'}
            </p>
          </section>
        )}

        {step === 'tour' && (
          <section>
            <h1 className="text-[27px] font-semibold tracking-[-0.02em]">How it works</h1>
            <p className="mt-4 text-sm leading-relaxed text-[#b5afac]">
              Four things happen every time you start a run.
            </p>
            <ol className="mt-7 grid gap-3.5">
              {TOUR_CARDS.map((card, index) => (
                <li key={card.title}>
                  <Card className="flex-row items-start gap-3.5 border-[#332e2e] bg-transparent p-4 shadow-none">
                    <span
                      aria-hidden="true"
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-[#2b2826] font-mono text-[11px] text-[#e9c9bc]"
                    >
                      {index + 1}
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-[#eeeae7]">{card.title}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-[#96908d]">{card.body}</span>
                    </span>
                  </Card>
                </li>
              ))}
            </ol>
          </section>
        )}

        {step === 'ready' && (
          <section>
            <h1 className="text-[27px] font-semibold tracking-[-0.02em]">You are ready</h1>
            <p className="mt-4 text-sm leading-relaxed text-[#b5afac]">
              {connected
                ? `${HARNESS_LABELS[connected]} is connected. The next screen is where you describe your first game.`
                : 'No agent is connected yet. You can look around, but a run cannot start until you sign in to one on the Agents tab.'}
            </p>
            <div className="mt-7 rounded-lg border border-[#332e2e] bg-[#171313] p-4">
              <h2 className="text-sm font-medium text-[#ded9d6]">Two things worth knowing</h2>
              <ul className="mt-2 grid gap-2 text-xs leading-relaxed text-[#96908d]">
                <li>
                  Runs take a while and use your subscription's allowance. If you hit its limit, the app
                  pauses and picks up again by itself.
                </li>
                <li>
                  Any dollar figure the app shows is an estimate of what the same work would cost through
                  a pay-per-use API. It is not your bill.
                </li>
              </ul>
            </div>
            <p className="mt-4 text-xs text-[#7d7772]">
              You can see this tour again from the Agents tab.
            </p>
          </section>
        )}

        <div className="mt-9 flex items-center gap-2.5">
          {previousStep(step) && (
            <Button
              variant="ghost"
              className="text-[#b5afac] hover:bg-white/5 hover:text-white"
              disabled={finishing}
              onClick={goBack}
            >
              <ArrowLeft /> Back
            </Button>
          )}
          <Button
            className="ml-auto"
            disabled={finishing || (step === 'connect' && (signingIn || installing))}
            onClick={goNext}
          >
            {finishing && <LoaderCircle className="animate-spin" />}
            {step === 'ready'
              ? 'Start your first game'
              : step === 'connect' && !canLeaveConnectStep(states)
                ? 'Continue without an agent'
                : 'Continue'}
            {!finishing && step !== 'ready' && <ArrowRight />}
          </Button>
        </div>
      </main>
    </div>
  )
}
