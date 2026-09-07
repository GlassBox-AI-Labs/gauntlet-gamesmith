import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_IMPLEMENTER, DEFAULT_CRITIC, DEFAULT_RESEARCH, DEFAULT_ASSET } from '../../../shared/models'
import { BuildSidebar, type BuildSidebarProps } from './BuildSidebar'

describe('BuildSidebar', () => {
  it('allows vertical scrolling without exposing horizontal overflow', () => {
    const markup = renderToStaticMarkup(
      <BuildSidebar
        snapshots={[]}
        reports={[]}
        selectedBuildId={null}
        selectedReportId={null}
        selectedRound={null}
        expandedBuilds={new Set()}
        editing={false}
        checkedBuilds={new Set()}
        onNewBuild={() => undefined}
        onImportBuild={() => undefined}
        onSelectBuild={() => undefined}
        onSelectRound={() => undefined}
        onToggleBuild={() => undefined}
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

  it('loads rounds when an unselected summary-only build is expanded', () => {
    const props: BuildSidebarProps = {
      snapshots: [{
        build: {
          id: 'unselected', title: 'Unselected build', workspaceDir: '/tmp/example', status: 'stopped',
          prompt: 'Goal', maxRounds: 10, budgetUsd: null, round: 4, totalCostUsd: 0, stopReason: null,
          playTrusted: true, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
          models: { ...DEFAULT_IMPLEMENTER, ...DEFAULT_CRITIC, ...DEFAULT_RESEARCH, ...DEFAULT_ASSET },
        },
        attempts: [], totalAttempts: 8,
      }],
      reports: [], selectedBuildId: 'another-build', selectedReportId: null, selectedRound: null,
      expandedBuilds: new Set(['unselected']), editing: false, checkedBuilds: new Set(),
      busy: false, historyWarning: null, hasMoreHistories: false, hasNewerHistories: false,
      onNewBuild() {}, onImportBuild() {}, onSelectBuild() {}, onSelectRound() {}, onToggleBuild() {},
      onOpenAgents() {}, onToggleEditing() {}, onToggleChecked() {}, onToggleAllChecked() {},
      onDeleteChecked() {}, onCreateReport() {}, onSelectReport() {}, onImportReport() {},
      onLoadOlderHistories() {}, onLoadNewestHistories() {},
    }

    const markup = renderToStaticMarkup(<BuildSidebar {...props} />)
    expect(markup).toContain('sidebar-rounds-unselected')
    expect(markup).toContain('Loading rounds…')
    expect(markup).not.toContain('No rounds yet.')
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
        editing={false}
        checkedBuilds={new Set()}
        onNewBuild={() => undefined}
        onImportBuild={() => undefined}
        onSelectBuild={() => undefined}
        onSelectRound={() => undefined}
        onToggleBuild={() => undefined}
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
