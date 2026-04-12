/* === VIVENTIUM START ===
 * Feature: Voice Chat LLM Override
 * Purpose: Panel for selecting a voice-specific model/provider in Agent Builder.
 * Mirrors ModelPanel.tsx but targets voice_llm_* fields so voice calls can own a separate
 * parameter bag without mutating the primary model settings.
 * Added: 2026-02-24
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

export default function VoiceLlmPanel({
  providers,
  setActivePanel,
  models: modelsData,
}: Pick<AgentModelPanelProps, 'models' | 'providers' | 'setActivePanel'>) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const previousProviderRef = useRef<string | undefined>(undefined);

  const voiceModel = useWatch({ control, name: 'voice_llm_model' });
  const voiceProvider = useWatch({ control, name: 'voice_llm_provider' });

  const provider = useMemo(() => {
    return voiceProvider ?? '';
  }, [voiceProvider]);

  const models = useMemo(
    () => (provider ? (modelsData[provider] ?? []) : []),
    [modelsData, provider],
  );

  useEffect(() => {
    const _model = voiceModel ?? '';
    if (!provider) {
      previousProviderRef.current = provider;
      return;
    }

    const resolvedModel = resolveAgentModelForProvider({
      provider,
      model: _model,
      availableModels: modelsData[provider] ?? [],
      previousProvider: previousProviderRef.current,
    });

    if (resolvedModel !== _model) {
      setValue('voice_llm_model', resolvedModel || null);
    }

    previousProviderRef.current = provider;
  }, [provider, models, modelsData, setValue, voiceModel]);

  const handleClear = () => {
    setValue('voice_llm_model', null);
    setValue('voice_llm_provider', null);
    setValue('voice_llm_model_parameters', {});
  };

  const voiceParametersTitle = `${localize('com_ui_voice_chat_llm')} ${localize('com_ui_model_parameters')}`;

  return (
    <div className="mx-1 mb-1 flex h-full min-h-[50vh] w-full flex-col gap-2 text-sm">
      <div className="model-panel relative flex flex-col items-center px-16 py-4 text-center">
        <div className="absolute left-0 top-4">
          <button
            type="button"
            className="btn btn-neutral relative"
            onClick={() => {
              setActivePanel(Panel.builder);
            }}
            aria-label={localize('com_ui_back_to_builder')}
          >
            <div className="model-panel-content flex w-full items-center justify-center gap-2">
              <ChevronLeft />
            </div>
          </button>
        </div>

        <div className="mb-1 mt-2 text-xl font-medium">{localize('com_ui_voice_chat_llm')}</div>
        <p className="text-token-text-secondary text-xs">
          {localize('com_ui_voice_chat_llm_description')}
        </p>
      </div>
      <div className="p-2">
        {/* Voice Provider */}
        <div className="mb-4">
          <label
            id="voice-provider-label"
            className="text-token-text-primary model-panel-label mb-2 block font-medium"
            htmlFor="voice_llm_provider"
          >
            {localize('com_ui_provider')}
          </label>
          <Controller
            name="voice_llm_provider"
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
        {/* Voice Model */}
        <div className="model-panel-section mb-4">
          <label
            id="voice-model-label"
            className={cn(
              'text-token-text-primary model-panel-label mb-2 block font-medium',
              !provider && 'text-gray-500 dark:text-gray-400',
            )}
            htmlFor="voice_llm_model"
          >
            {localize('com_ui_model')}
          </label>
          <Controller
            name="voice_llm_model"
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
        fieldName="voice_llm_model_parameters"
        provider={provider}
        model={voiceModel ?? ''}
        title={voiceParametersTitle}
      />
      {/* Clear Button */}
      <button
        type="button"
        onClick={handleClear}
        className="btn btn-neutral my-1 flex w-full items-center justify-center gap-2 px-4 py-2 text-sm"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {localize('com_ui_voice_chat_llm_clear')}
      </button>
    </div>
  );
}
