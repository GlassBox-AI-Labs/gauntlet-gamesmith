import { AGENT_MODEL_CHOICES, harnessFor } from '../../../shared/models'
import { SelectGroup, SelectItem, SelectLabel } from './ui/select'

export function ModelSelectItems(): React.JSX.Element {
  return <>{(['claude', 'codex'] as const).map((harness) => <SelectGroup key={harness}>
    <SelectLabel>{harness === 'claude' ? 'Claude models' : 'Codex models'}</SelectLabel>
    {AGENT_MODEL_CHOICES.filter((model) => harnessFor(model.id) === harness).map((model) =>
      <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
    )}
  </SelectGroup>)}</>
}
