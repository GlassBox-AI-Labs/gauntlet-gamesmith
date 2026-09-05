import { AGENT_MODEL_CHOICES } from '../../../shared/models'
import { harnessKinds, HARNESS_LABELS } from '../../../shared/harness'
import { SelectGroup, SelectItem, SelectLabel } from './ui/select'

export function ModelSelectItems(): React.JSX.Element {
  return <>{harnessKinds.map((harness) => <SelectGroup key={harness}>
    <SelectLabel>{HARNESS_LABELS[harness]} models</SelectLabel>
    {AGENT_MODEL_CHOICES.filter((model) => model.harness === harness).map((model) =>
      <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
    )}
  </SelectGroup>)}</>
}
