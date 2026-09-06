import type { RequirementSnapshot } from '../shared/steering'
import type { CastEntry } from './asset-phase'

/** Directly supplied replacements suppress old-cast rebuilds; new sculpt requests join this round. */
export function steeringCastWork(snapshot: RequirementSnapshot, wanted: CastEntry[], original: CastEntry[]): CastEntry[] {
  const preferences = new Map(snapshot.directives.flatMap(directive => directive.assetChanges ?? []).map(change => [change.target, change]))
  const result = new Map(wanted.filter(entry => preferences.get(entry.name)?.operation !== 'use-file').map(entry => [entry.name, entry]))
  for (const change of snapshot.assetWork ?? []) {
    if (change.operation !== 'sculpt') continue
    const previous = original.find(entry => entry.name === change.target)
    const sources = (snapshot.attachments ?? []).filter(file => change.attachmentIds.includes(file.id)).map(file => file.path)
    result.set(change.target, {
      name: change.target, kind: previous?.kind ?? 'prop', priority: previous?.priority ?? 1,
      stills: sources.length ? sources : previous?.stills ?? [],
      locator: sources.length ? 'Use the exact project-relative steering attachment paths listed here; inspect the user-supplied reference.' : previous?.locator ?? 'Follow the operator direction for this model.',
      role: snapshot.directives.filter(directive => directive.assetChanges?.some(item => item.target === change.target)).at(-1)?.text ?? previous?.role ?? '',
    })
  }
  return [...result.values()]
}
