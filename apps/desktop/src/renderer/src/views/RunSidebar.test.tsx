import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RunSidebar } from './RunSidebar'

describe('RunSidebar', () => {
  it('allows vertical scrolling without exposing horizontal overflow', () => {
    const markup = renderToStaticMarkup(
      <RunSidebar
        snapshots={[]}
        reports={[]}
        selectedLoopId={null}
        selectedReportId={null}
        selectedRound={null}
        expandedRuns={new Set()}
        visibleRounds={{}}
        editing={false}
        checkedRuns={new Set()}
        onNewRun={() => undefined}
        onImportRun={() => undefined}
        onSelectRun={() => undefined}
        onSelectRound={() => undefined}
        onToggleRun={() => undefined}
        onLoadMore={() => undefined}
        onOpenAgents={() => undefined}
        onToggleEditing={() => undefined}
        onToggleChecked={() => undefined}
        onToggleAllChecked={() => undefined}
        onDeleteChecked={() => undefined}
        onCreateReport={() => undefined}
        onSelectReport={() => undefined}
        onImportReport={() => undefined}
        onLoadOlderHistories={() => undefined}
        onLoadNewestHistories={() => undefined}
        busy={false}
        historyWarning={null}
        hasMoreHistories={false}
        hasNewerHistories={false}
      />,
    )

    expect(markup).toContain('w-[252px] min-w-0 shrink-0 flex-col overflow-hidden')
    expect(markup).toContain('min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto')
  })
})
