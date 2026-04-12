import React, { useMemo, useEffect, useRef } from 'react';
import { ControlCombobox } from '@librechat/client';
import { ChevronLeft } from 'lucide-react';
import { useFormContext, useWatch, Controller } from 'react-hook-form';
import {
  alternateName,
  LocalStorageKeys,
} from 'librechat-data-provider';
import type { AgentForm, AgentModelPanelProps, StringOption } from '~/common';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';
import { cn } from '~/utils';
import { resolveAgentModelForProvider } from './modelSelection';
import ModelParametersSection from './ModelParametersSection';

export default function ModelPanel({
  providers,
  setActivePanel,
  models: modelsData,
}: Pick<AgentModelPanelProps, 'models' | 'providers' | 'setActivePanel'>) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const previousProviderRef = useRef<string | undefined>(undefined);

  const model = useWatch({ control, name: 'model' });
  const providerOption = useWatch({ control, name: 'provider' });
  useWatch({ control, name: 'model_parameters' });

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
                  ? field.value
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
                    selectPlaceholder={
                      provider
                        ? localize('com_ui_select_model')
                        : localize('com_ui_select_provider_first')
                    }
                    searchPlaceholder={localize('com_ui_select_model')}
                    setValue={field.onChange}
                    items={models.map((model) => ({
                      label: model,
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
      </div>
      <ModelParametersSection
        fieldName="model_parameters"
        provider={provider}
        model={model ?? ''}
        title={localize('com_ui_model_parameters')}
      />
    </div>
  );
}
