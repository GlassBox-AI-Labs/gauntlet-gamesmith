import { useState } from 'react'
import { Repeat, Sparkles } from 'lucide-react'
import { AgentsView } from '@/views/AgentsView'
import { RunView } from '@/views/RunView'

type View = 'run' | 'agents'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('run')

  const navButton = (target: View, icon: React.JSX.Element, label: string): React.JSX.Element => (
    <button
      type="button"
      onClick={() => setView(target)}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
        view === target ? 'bg-[#2b2826] text-[#eeeae7]' : 'text-[#96908d] hover:text-[#ded9d6]'
      }`}
    >
      {icon} {label}
    </button>
  )

  return (
    <>
      <nav className="sticky top-0 z-10 border-b border-[#2a2626] bg-[#100d0e]/90 backdrop-blur">
        <div className="mx-auto flex w-[min(980px,calc(100%-48px))] items-center gap-1.5 py-2.5 max-sm:w-[calc(100%-28px)]">
          <span className="mr-3 text-[13px] font-semibold tracking-[-0.01em] text-[#e9c9bc]">Gauntlet Loop</span>
          {navButton('run', <Repeat className="size-3.5" />, 'Run')}
          {navButton('agents', <Sparkles className="size-3.5" />, 'Agents')}
        </div>
      </nav>
      {view === 'run' ? <RunView /> : <AgentsView />}
    </>
  )
}
