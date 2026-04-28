/* === VIVENTIUM START ===
 * Feature: Optional Agent LLM Routes
 * Purpose: Shared nested model/provider panel for secondary agent routes such as
 * voice-call LLM and provider-failure fallback LLM.
 * Added: 2026-04-28
 * === VIVENTIUM END === */
import React, { useMemo, useEffect, useRef } from 'react';
import { ControlCombobox } from '@librechat/client';
import { ChevronLeft, Trash2 } from 'lucide-react';
import { useFormContext, useWatch, Controller } from 'react-hook-form';
import { alternateName } from 'librechat-data-provider';
import type { AgentForm, AgentModelPanelProps } from '~/common';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';
import { cn } from '~/utils';
import { resolveAgentModelForProvider } from './modelSelection';
import ModelParametersSection from './ModelParametersSection';

type OptionalLlmFieldNames = {
  provider: 'voice_llm_provider' | 'fallback_llm_provider' | 'voice_fallback_llm_provider';
  model: 'voice_llm_model' | 'fallback_llm_model' | 'voice_fallback_llm_model';
  parameters:
    | 'voice_llm_model_parameters'
    | 'fallback_llm_model_parameters'
    | 'voice_fallback_llm_model_parameters';
};

type OptionalLlmPanelProps = Pick<
  AgentModelPanelProps,
  'models' | 'providers' | 'setActivePanel'
> & {
  title: string;
  description: string;
  clearLabel: string;
  fields: OptionalLlmFieldNames;
  backPanel?: Panel;
  children?: React.ReactNode;
};

export default function OptionalLlmPanel({
  providers,
  setActivePanel,
  models: modelsData,
  title,
  description,
  clearLabel,
  fields,
  backPanel = Panel.builder,
  children,
}: OptionalLlmPanelProps) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const previousProviderRef = useRef<string | undefined>(undefined);

  const selectedModel = useWatch({ control, name: fields.model });
  const selectedProvider = useWatch({ control, name: fields.provider });

  const provider = useMemo(() => selectedProvider ?? '', [selectedProvider]);

  const models = useMemo(
    () => (provider ? (modelsData[provider] ?? []) : []),
    [modelsData, provider],
  );

  useEffect(() => {
    const currentModel = selectedModel ?? '';
    if (!provider) {
      previousProviderRef.current = provider;
      return;
    }

    const resolvedModel = resolveAgentModelForProvider({
      provider,
      model: currentModel,
      availableModels: modelsData[provider] ?? [],
      previousProvider: previousProviderRef.current,
    });

    if (resolvedModel !== currentModel) {
      setValue(fields.model, resolvedModel || null);
    }

    previousProviderRef.current = provider;
  }, [fields.model, provider, models, modelsData, setValue, selectedModel]);

  const handleClear = () => {
    setValue(fields.model, null);
    setValue(fields.provider, null);
    setValue(fields.parameters, {});
  };

  const parametersTitle = `${title} ${localize('com_sidepanel_parameters')}`;

  return (
    <div className="mx-1 mb-1 flex h-full min-h-[50vh] w-full flex-col gap-2 text-sm">
      <div className="model-panel relative flex flex-col items-center px-16 py-4 text-center">
        <div className="absolute left-0 top-4">
          <button
            type="button"
            className="btn btn-neutral relative"
            onClick={() => {
              setActivePanel(backPanel);
            }}
            aria-label={localize('com_ui_back_to_builder')}
          >
            <div className="model-panel-content flex w-full items-center justify-center gap-2">
              <ChevronLeft />
            </div>
          </button>
        </div>

        <div className="mb-1 mt-2 text-xl font-medium">{title}</div>
        <p className="text-token-text-secondary text-xs">{description}</p>
      </div>
      <div className="p-2">
        <div className="mb-4">
          <label
            id={`${fields.provider}-label`}
            className="text-token-text-primary model-panel-label mb-2 block font-medium"
            htmlFor={fields.provider}
          >
            {localize('com_ui_provider')}
          </label>
          <Controller
            name={fields.provider}
            control={control}
            render={({ field }) => {
              const value = field.value ?? '';
              return (
                <ControlCombobox
                  selectedValue={value}
                  displayValue={alternateName[value] ?? value}
                  selectPlaceholder={localize('com_ui_select_provider')}
                  searchPlaceholder={localize('com_ui_select_search_provider')}
                  setValue={(val: string) => {
                    field.onChange(val || null);
                  }}
                  items={providers.map((p) => ({
                    label: typeof p === 'string' ? p : p.label,
                    value: typeof p === 'string' ? p : p.value,
                  }))}
                  ariaLabel={localize('com_ui_provider')}
                  isCollapsed={false}
                  showCarat={true}
                />
              );
            }}
          />
        </div>
        <div className="model-panel-section mb-4">
          <label
            id={`${fields.model}-label`}
            className={cn(
              'text-token-text-primary model-panel-label mb-2 block font-medium',
              !provider && 'text-gray-500 dark:text-gray-400',
            )}
            htmlFor={fields.model}
          >
            {localize('com_ui_model')}
          </label>
          <Controller
            name={fields.model}
            control={control}
            render={({ field }) => {
              return (
                <ControlCombobox
                  selectedValue={field.value || ''}
                  selectPlaceholder={
                    provider
                      ? localize('com_ui_select_model')
                      : localize('com_ui_select_provider_first')
                  }
                  searchPlaceholder={localize('com_ui_select_model')}
                  setValue={(val: string) => {
                    field.onChange(val || null);
                  }}
                  items={models.map((m) => ({
                    label: m,
                    value: m,
                  }))}
                  disabled={!provider}
                  className={cn('disabled:opacity-50')}
                  ariaLabel={localize('com_ui_model')}
                  isCollapsed={false}
                  showCarat={true}
                />
              );
            }}
          />
        </div>
      </div>
      <ModelParametersSection
        fieldName={fields.parameters}
        provider={provider}
        model={selectedModel ?? ''}
        title={parametersTitle}
      />
      {children}
      <button
        type="button"
        onClick={handleClear}
        className="btn btn-neutral my-1 flex w-full items-center justify-center gap-2 px-4 py-2 text-sm"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {clearLabel}
      </button>
    </div>
  );
}
