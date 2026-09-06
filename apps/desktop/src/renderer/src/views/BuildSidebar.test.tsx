import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BuildSidebar } from './BuildSidebar'

describe('RunSidebar', () => {
  it('allows vertical scrolling without exposing horizontal overflow', () => {
    const markup = renderToStaticMarkup(
      <BuildSidebar
        snapshots={[]}
        reports={[]}
        selectedBuildId={null}
        selectedReportId={null}
        selectedRound={null}
        expandedBuilds={new Set()}
        visibleRounds={{}}
        editing={false}
        checkedBuilds={new Set()}
        onNewBuild={() => undefined}
        onImportBuild={() => undefined}
        onSelectBuild={() => undefined}
        onSelectRound={() => undefined}
        onToggleBuild={() => undefined}
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

  it('reserves room for build and round status labels', () => {
    const snapshot = {
      build: {
        id: 'build-1',
        title: 'A deliberately long build title that must yield space to status',
        workspaceDir: '/tmp/example',
        status: 'running',
      },
      attempts: [{ id: 'build-1', round: 1, status: 'running', verdict: null }],
    }
    const markup = renderToStaticMarkup(
      <BuildSidebar
        snapshots={[snapshot as never]}
        reports={[]}
        selectedBuildId="build-1"
        selectedReportId={null}
        selectedRound={1}
        expandedBuilds={new Set(['build-1'])}
        visibleRounds={{}}
        editing={false}
        checkedBuilds={new Set()}
        onNewBuild={() => undefined}
        onImportBuild={() => undefined}
        onSelectBuild={() => undefined}
        onSelectRound={() => undefined}
        onToggleBuild={() => undefined}
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

    expect(markup).toContain('shrink-0 items-center gap-1 whitespace-nowrap')
    expect(markup).toContain('ml-2 shrink-0 whitespace-nowrap text-amber-300')
    expect(markup).toContain('grid-cols-[minmax(0,1fr)]')
    expect(markup).toContain('Round 1</span><span')
    expect(markup).toContain('active</span>')
  })
})
