/* === VIVENTIUM START === Independent capability-backed background worker preferences. === */
import React from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import type { TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';
import AgentModelPicker from './AgentModelPicker';

export default function BackgroundWorkerOptions({
  providerCapability,
}: {
  providerCapability: TAgentProviderCapability;
}) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const options = useWatch({ control, name: 'glasshive_options.orchestration' });
  const models = providerCapability.models ?? [];
  const fields = [
    {
      model: 'worker_model',
      effort: 'worker_reasoning_effort',
      profile: 'worker_profile',
      label: localize('com_ui_background_worker_model'),
      effortLabel: localize('com_ui_background_worker_effort'),
    },
    {
      model: 'fallback_worker_model',
      effort: 'fallback_worker_reasoning_effort',
      profile: 'fallback_worker_profile',
      label: localize('com_ui_background_worker_fallback_model'),
      effortLabel: localize('com_ui_background_worker_fallback_effort'),
    },
  ] as const;
  return (
    <fieldset className="mb-4 border-t border-border-light pt-4">
      <legend className="text-sm font-medium">
        {localize('com_ui_background_worker_preference')}
      </legend>
      <p className="mb-3 text-xs text-text-secondary">
        {localize('com_ui_background_worker_preference_help')}
      </p>
      {fields.map(({ model, effort, profile, label, effortLabel }) => {
        const selected = options?.[model] ?? '';
        const configuredEffort = options?.[effort] ?? '';
        const capability = models.find((candidate) => candidate.id === selected);
        const modelField = `glasshive_options.orchestration.${model}` as const;
        const effortField = `glasshive_options.orchestration.${effort}` as const;
        return (
          <div key={model} className="mb-3">
            <label htmlFor={model} className="mb-1 block text-sm font-medium">
              {label}
            </label>
            <Controller
              name={modelField}
              control={control}
              render={({ field }) => (
                <AgentModelPicker
                  selectedValue={selected}
                  displayValue={
                    capability?.label ?? (selected || localize('com_ui_worker_profile_default'))
                  }
                  ariaLabel={label}
                  harnessLabel={
                    model === 'worker_model'
                      ? 'Background provider'
                      : 'Background fallback provider'
                  }
                  modelCapabilities={models}
                  selectPlaceholder={label}
                  searchPlaceholder={label}
                  items={[
                    { value: '', label: localize('com_ui_worker_profile_default') },
                    ...(selected && !capability
                      ? [
                          {
                            value: selected,
                            label: `${selected} (${localize('com_ui_model_unavailable')})`,
                          },
                        ]
                      : []),
                    ...models.map((candidate) => ({ value: candidate.id, label: candidate.label })),
                  ]}
                  setValue={(value: string) => {
                    field.onChange(value);
                    const next = models.find((candidate) => candidate.id === value);
                    if (next?.harnessProfile) {
                      setValue(`glasshive_options.orchestration.${profile}`, next.harnessProfile, {
                        shouldDirty: true,
                      });
                    }
                    if (!next || !next.effortChoices?.includes(configuredEffort)) {
                      setValue(effortField, next?.recommendedEffort ?? '', { shouldDirty: true });
                    }
                  }}
                  isCollapsed={false}
                  showCarat={true}
                />
              )}
            />
            {selected && (
              <>
                <label htmlFor={effort} className="mb-1 mt-2 block text-sm font-medium">
                  {effortLabel}
                </label>
                <Controller
                  name={effortField}
                  control={control}
                  render={({ field }) => (
                    <select
                      {...field}
                      id={effort}
                      value={configuredEffort}
                      className="h-10 w-full rounded-lg border border-border-light bg-surface-primary px-3"
                    >
                      <option value="">{localize('com_ui_model_default')}</option>
                      {configuredEffort &&
                        !capability?.effortChoices?.includes(configuredEffort) && (
                          <option value={configuredEffort}>
                            {configuredEffort} ({localize('com_ui_model_unavailable')})
                          </option>
                        )}
                      {capability?.effortChoices?.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  )}
                />
              </>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
/* === VIVENTIUM END === */
