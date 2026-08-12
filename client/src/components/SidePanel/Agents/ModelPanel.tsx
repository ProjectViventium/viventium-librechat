import React, { useMemo, useEffect, useRef } from 'react';
import { ControlCombobox } from '@librechat/client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useFormContext, useWatch, Controller } from 'react-hook-form';
import { alternateName, LocalStorageKeys } from 'librechat-data-provider';
import type { TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm, AgentModelPanelProps, StringOption } from '~/common';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';
import { cn } from '~/utils';
import {
  resolveAgentModelForProvider,
  shouldDefaultOpenAIGPT56AgentToResponses,
} from './modelSelection';
import ModelParametersSection from './ModelParametersSection';
import CapabilityProviderOptions from './CapabilityProviderOptions';

export default function ModelPanel({
  providers,
  setActivePanel,
  models: modelsData,
  providerCapabilities,
}: Pick<AgentModelPanelProps, 'models' | 'providers' | 'setActivePanel'> & {
  providerCapabilities: Record<string, TAgentProviderCapability>;
}) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const previousProviderRef = useRef<string | undefined>(undefined);

  const model = useWatch({ control, name: 'model' });
  const providerOption = useWatch({ control, name: 'provider' });
  const fallbackModel = useWatch({ control, name: 'fallback_llm_model' });
  const fallbackProvider = useWatch({ control, name: 'fallback_llm_provider' });
  const modelParameters = useWatch({ control, name: 'model_parameters' });
  const provider = useMemo(() => {
    const value =
      typeof providerOption === 'string'
        ? providerOption
        : (providerOption as StringOption | undefined)?.value;
    return value ?? '';
  }, [providerOption]);
  const models = useMemo(
    () => (provider ? (modelsData[provider] ?? []) : []),
    [modelsData, provider],
  );
  const providerCapability = providerCapabilities[provider];
  const modelCapability = useMemo(
    () => providerCapability?.models?.find((candidate) => candidate.id === model),
    [model, providerCapability?.models],
  );

  useEffect(() => {
    const _model = model ?? '';
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
      setValue('model', resolvedModel);
    }

    if (resolvedModel) {
      localStorage.setItem(LocalStorageKeys.LAST_AGENT_MODEL, resolvedModel);
      localStorage.setItem(LocalStorageKeys.LAST_AGENT_PROVIDER, provider);
    }

    previousProviderRef.current = provider;
  }, [provider, models, modelsData, setValue, model]);

  /* === VIVENTIUM START ===
   * Feature: Persist GPT-5.6's Agent Builder Responses default in the visible form.
   * Purpose: Keep saved model parameters aligned with backend execution while preserving a user's
   * explicit true/false choice.
   * === VIVENTIUM END === */
  useEffect(() => {
    if (
      shouldDefaultOpenAIGPT56AgentToResponses({
        provider,
        model: model ?? '',
        useResponsesApi: modelParameters?.useResponsesApi,
      })
    ) {
      setValue('model_parameters.useResponsesApi', true, { shouldDirty: true });
    }
  }, [model, modelParameters?.useResponsesApi, provider, setValue]);
  /* === VIVENTIUM END === */

  /* === VIVENTIUM START ===
   * Feature: Capability-owned chat-completions transport
   * Purpose: A saved OpenAI Responses preference must not follow an agent onto a provider that
   * declares only Chat Completions; otherwise LibreChat calls an unsupported /responses route.
   * === VIVENTIUM END === */
  useEffect(() => {
    if (providerCapability?.responses_api === false && modelParameters?.useResponsesApi === true) {
      setValue('model_parameters.useResponsesApi', false, { shouldDirty: true });
    }
  }, [modelParameters?.useResponsesApi, providerCapability?.responses_api, setValue]);

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

        <div className="mb-2 mt-2 text-xl font-medium">{localize('com_ui_model_parameters')}</div>
      </div>
      <div className="p-2">
        {/* Endpoint aka Provider for Agents */}
        <div className="mb-4">
          <label
            id="provider-label"
            className="text-token-text-primary model-panel-label mb-2 block font-medium"
            htmlFor="provider"
          >
            {localize('com_ui_provider')} <span className="text-red-500">*</span>
          </label>
          <Controller
            name="provider"
            control={control}
            rules={{ required: true, minLength: 1 }}
            render={({ field, fieldState: { error } }) => {
              const value =
                typeof field.value === 'string'
                  ? field.value
                  : ((field.value as StringOption)?.value ?? '');
              const display =
                typeof field.value === 'string'
                  ? (providerCapabilities[value]?.label ?? field.value)
                  : ((field.value as StringOption)?.label ?? '');

              return (
                <>
                  <ControlCombobox
                    selectedValue={value}
                    displayValue={alternateName[display] ?? display}
                    selectPlaceholder={localize('com_ui_select_provider')}
                    searchPlaceholder={localize('com_ui_select_search_provider')}
                    setValue={field.onChange}
                    items={providers.map((provider) => ({
                      label: typeof provider === 'string' ? provider : provider.label,
                      value: typeof provider === 'string' ? provider : provider.value,
                    }))}
                    className={cn(error ? 'border-2 border-red-500' : '')}
                    ariaLabel={localize('com_ui_provider')}
                    isCollapsed={false}
                    showCarat={true}
                  />
                  {error && (
                    <span className="model-panel-error text-sm text-red-500 transition duration-300 ease-in-out">
                      {localize('com_ui_field_required')}
                    </span>
                  )}
                </>
              );
            }}
          />
        </div>
        {/* Model */}
        <div className="model-panel-section mb-4">
          <label
            id="model-label"
            className={cn(
              'text-token-text-primary model-panel-label mb-2 block font-medium',
              !provider && 'text-gray-500 dark:text-gray-400',
            )}
            htmlFor="model"
          >
            {localize('com_ui_model')} <span className="text-red-500">*</span>
          </label>
          <Controller
            name="model"
            control={control}
            rules={{ required: true, minLength: 1 }}
            render={({ field, fieldState: { error } }) => {
              return (
                <>
                  <ControlCombobox
                    selectedValue={field.value || ''}
                    displayValue={
                      providerCapability?.models?.find((item) => item.id === field.value)?.label ??
                      field.value ??
                      ''
                    }
                    selectPlaceholder={
                      provider
                        ? localize('com_ui_select_model')
                        : localize('com_ui_select_provider_first')
                    }
                    searchPlaceholder={localize('com_ui_select_model')}
                    setValue={field.onChange}
                    items={models.map((model) => ({
                      label:
                        providerCapability?.models?.find((item) => item.id === model)?.label ??
                        model,
                      value: model,
                    }))}
                    disabled={!provider}
                    className={cn('disabled:opacity-50', error ? 'border-2 border-red-500' : '')}
                    ariaLabel={localize('com_ui_model')}
                    isCollapsed={false}
                    showCarat={true}
                  />
                  {provider && error && (
                    <span className="text-sm text-red-500 transition duration-300 ease-in-out">
                      {localize('com_ui_field_required')}
                    </span>
                  )}
                </>
              );
            }}
          />
        </div>
        {/* === VIVENTIUM START ===
         * Feature: capability-backed Agent provider controls.
         * Purpose: Share readiness, workspace/access, and effort behavior with optional routes.
         * === VIVENTIUM END === */}
        <CapabilityProviderOptions
          provider={provider}
          model={model ?? ''}
          parameterField="model_parameters"
          providerCapability={providerCapability}
        />
        {/* === VIVENTIUM START ===
         * Feature: Agent Fallback LLM
         * Purpose: Let users configure the secondary model from the existing Model Parameters page.
         * Added: 2026-04-28
         */}
        <div className="model-panel-section mb-4">
          <label
            id="fallback-llm-label"
            className="text-token-text-primary model-panel-label mb-2 block font-medium"
          >
            {localize('com_ui_fallback_llm')}
          </label>
          <button
            type="button"
            onClick={() => setActivePanel(Panel.fallbackLlmModel)}
            className="btn btn-neutral border-token-border-light relative h-10 w-full rounded-lg font-medium"
            aria-haspopup="true"
            aria-expanded="false"
            aria-labelledby="fallback-llm-label"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <span className="truncate text-left">
                {fallbackModel && fallbackProvider
                  ? `${fallbackModel}`
                  : localize('com_ui_fallback_llm_empty')}
              </span>
              <ChevronRight className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            </div>
          </button>
          <p className="text-token-text-secondary mt-1 text-xs">
            {localize('com_ui_fallback_llm_short_description')}
          </p>
        </div>
        {/* === VIVENTIUM END === */}
      </div>
      <ModelParametersSection
        fieldName="model_parameters"
        provider={provider}
        model={model ?? ''}
        title={localize('com_ui_model_parameters')}
        excludedParameterKeys={
          (modelCapability?.effortChoices?.length ?? 0) > 0 ? ['reasoning_effort'] : []
        }
      />
    </div>
  );
}
