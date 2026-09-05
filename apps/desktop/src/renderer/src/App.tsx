import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { AgentsView } from '@/views/AgentsView'
import { RunFormPrototype } from '@/views/RunFormPrototype'
import { RunView } from '@/views/RunView'

type View = 'run' | 'agents'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('run')

  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('prototype') === 'run-form') {
    return <RunFormPrototype />
  }

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
      <AgentsView />
    </div>
  )
}
