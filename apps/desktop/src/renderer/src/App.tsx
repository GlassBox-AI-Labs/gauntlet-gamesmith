import { useEffect, useState } from 'react'
import { ArrowLeft, LoaderCircle } from 'lucide-react'
import { AgentsView } from '@/views/AgentsView'
import { OnboardingView } from '@/views/OnboardingView'
import { RunView } from '@/views/RunView'

type View = 'run' | 'agents'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('run')
  // Null until the main process answers, so the app never flashes the Runs
  // view at a first-time user before the flow appears.
  const [onboarded, setOnboarded] = useState<boolean | null>(null)

  useEffect(() => {
    let disposed = false
    void window.onboarding.get()
      .then((state) => { if (!disposed) setOnboarded(state.completed) })
      // A failed read means an unknown answer. Showing the app is the kinder
      // guess: a returning user is not blocked, and the flow stays reachable
      // from the Agents tab.
      .catch(() => { if (!disposed) setOnboarded(true) })
    return () => { disposed = true }
  }, [])

  if (onboarded === null) {
    return (
      <div className="grid min-h-screen place-items-center" role="status" aria-live="polite">
        <LoaderCircle className="size-5 animate-spin text-[#7d7772]" />
        <span className="sr-only">Starting Gauntlet Gamesmith</span>
      </div>
    )
  }

  if (!onboarded) return <OnboardingView onDone={() => setOnboarded(true)} />

  if (view === 'run') return <RunView onOpenAgents={() => setView('agents')} />

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 border-b border-[#2a2626] bg-[#100d0e]/90 backdrop-blur">
        <div className="mx-auto flex w-[min(980px,calc(100%-48px))] items-center py-2.5 max-sm:w-[calc(100%-28px)]">
          <button
            type="button"
            onClick={() => setView('run')}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-[#96908d] hover:bg-white/[0.04] hover:text-[#ded9d6]"
          >
            <ArrowLeft className="size-3.5" /> Runs
          </button>
        </div>
      </nav>
      <AgentsView onReplayTour={() => setOnboarded(false)} />
    </div>
  )
}
