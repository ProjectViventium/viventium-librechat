/* === VIVENTIUM START ===
 * Share the capability-backed harness/model picker across Main, Voice, and fallback routes.
 * The exact model ID owns the harness; no second selection is persisted.
 * === VIVENTIUM END === */
import React from 'react';
import { ControlCombobox } from '@librechat/client';
import type { TAgentProviderCapability } from 'librechat-data-provider';

type Props = React.ComponentProps<typeof ControlCombobox> & {
  modelCapabilities?: TAgentProviderCapability['models'];
  harnessLabel?: string;
};
const harnessLabels: Record<string, string> = {
  'codex-cli': 'OpenAI',
  'claude-code': 'Anthropic',
  'grok-build': 'Grok',
  'openclaw-general': 'OpenClaw',
};

export default function AgentModelPicker({
  modelCapabilities = [],
  harnessLabel = 'Harness provider',
  ...props
}: Props) {
  const selected = modelCapabilities.find((model) => model.id === props.selectedValue);
  const profiles = Array.from(
    new Set(modelCapabilities.map((model) => model.harnessProfile)),
  ).filter((profile): profile is string => Boolean(profile));
  if (profiles.length === 0) {
    return <ControlCombobox {...props} />;
  }
  const profile = selected?.harnessProfile ?? '';
  const models = profile
    ? props.items.filter(
        (item) =>
          item.value === '' ||
          modelCapabilities.some(
            (model) => model.id === item.value && model.harnessProfile === profile,
          ),
      )
    : props.items;
  return (
    <>
      <label className="mb-2 block font-medium" htmlFor={`${props.ariaLabel}-harness`}>
        {harnessLabel}
      </label>
      <ControlCombobox
        selectedValue={profile}
        displayValue={harnessLabels[profile] ?? profile}
        selectPlaceholder="Select harness provider"
        searchPlaceholder="Search harness providers"
        items={profiles.map((value) => ({ value, label: harnessLabels[value] ?? value }))}
        setValue={(value: string) => {
          const model = props.items.find((item) =>
            modelCapabilities.some(
              (candidate) => candidate.id === item.value && candidate.harnessProfile === value,
            ),
          );
          if (model) props.setValue(model.value);
        }}
        ariaLabel={harnessLabel}
        isCollapsed={false}
        showCarat={true}
      />
      <div className="mt-3">
        <ControlCombobox {...props} items={models} />
      </div>
    </>
  );
}
