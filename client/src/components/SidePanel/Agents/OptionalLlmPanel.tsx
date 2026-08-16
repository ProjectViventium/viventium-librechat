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
import { useQuery } from '@tanstack/react-query';
import { alternateName, request } from 'librechat-data-provider';
import type { AgentModelParameters, TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm, AgentModelPanelProps } from '~/common';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';
import { cn } from '~/utils';
import { didAgentProviderChange, resolveAgentModelForProvider } from './modelSelection';
import ModelParametersSection from './ModelParametersSection';

type ProviderReadiness = {
  status: string;
  detail: string;
  models: Array<{
    id: string;
    readiness?: { status?: string; authentication?: string; detail?: string };
  }>;
};

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
  providerCapabilities?: Record<string, TAgentProviderCapability>;
  title: string;
  description: string;
  clearLabel: string;
  fields: OptionalLlmFieldNames;
  backPanel?: Panel;
  children?: React.ReactNode;
};

export default function OptionalLlmPanel({
  providers,
  providerCapabilities = {},
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
  const parameterValues = useWatch({ control, name: fields.parameters }) as
    AgentModelParameters | undefined;
  const glassHiveOptions = useWatch({ control, name: 'glasshive_options' });

  const provider = useMemo(() => selectedProvider ?? '', [selectedProvider]);

  const models = useMemo(
    () => (provider ? (modelsData[provider] ?? []) : []),
    [modelsData, provider],
  );
  const providerCapability = providerCapabilities[provider];
  const hasWorkspaceBinding = providerCapability?.workspace_binding === true;
  const modelCapability = useMemo(
    () => providerCapability?.models?.find((item) => item.id === selectedModel),
    [providerCapability?.models, selectedModel],
  );
  const readinessQuery = useQuery<ProviderReadiness>(
    ['agent-provider-readiness', provider],
    () =>
      request.get<ProviderReadiness>(
        `/api/agents/provider-readiness/${encodeURIComponent(provider)}`,
      ),
    {
      enabled: hasWorkspaceBinding,
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  );
  const selectedReadiness = readinessQuery.data?.models.find(
    (item) => item.id === selectedModel,
  )?.readiness;
  const readinessStatus = readinessQuery.isLoading
    ? 'checking'
    : selectedReadiness?.status || readinessQuery.data?.status || 'unavailable';
  const readinessLabel =
    readinessStatus === 'ready'
      ? localize('com_ui_glasshive_authenticated_ready')
      : readinessStatus === 'authentication_required'
        ? localize('com_ui_glasshive_sign_in_required')
        : readinessStatus === 'checking'
          ? localize('com_ui_glasshive_checking')
          : localize('com_ui_unavailable');
  const readinessDetail =
    selectedReadiness?.detail ||
    readinessQuery.data?.detail ||
    localize('com_ui_glasshive_unreachable');

  useEffect(() => {
    const currentModel = selectedModel ?? '';
    /* === VIVENTIUM START ===
     * Feature: Optional-route provider parameter isolation.
     * Purpose: Clear only the previous provider's parameter bag on a user-driven provider change.
     * Initial hydration preserves the persisted route exactly.
     * === VIVENTIUM END === */
    if (
      didAgentProviderChange({
        provider,
        previousProvider: previousProviderRef.current,
      })
    ) {
      setValue(fields.parameters as never, {} as never);
    }

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
  }, [fields.model, fields.parameters, provider, models, modelsData, setValue, selectedModel]);

  useEffect(() => {
    const effortChoices = modelCapability?.effortChoices ?? [];
    const currentEffort = String(parameterValues?.reasoning_effort ?? '');
    if (
      modelCapability?.recommendedEffort &&
      (!currentEffort || !effortChoices.includes(currentEffort))
    ) {
      setValue(
        `${fields.parameters}.reasoning_effort` as never,
        modelCapability.recommendedEffort as never,
        { shouldDirty: true },
      );
    }
  }, [
    fields.parameters,
    modelCapability?.effortChoices,
    modelCapability?.recommendedEffort,
    parameterValues?.reasoning_effort,
    setValue,
  ]);

  useEffect(() => {
    if (!hasWorkspaceBinding) {
      return;
    }
    if (!glassHiveOptions?.workspace?.mode) {
      setValue('glasshive_options.workspace.mode', 'life', { shouldDirty: true });
    }
    if (!glassHiveOptions?.access) {
      setValue('glasshive_options.access', 'full', { shouldDirty: true });
    }
  }, [glassHiveOptions?.access, glassHiveOptions?.workspace?.mode, hasWorkspaceBinding, setValue]);

  const handleClear = () => {
    setValue(fields.model, null);
    setValue(fields.provider, null);
    setValue(fields.parameters as never, {} as never);
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
              const display = providerCapabilities[value]?.label ?? value;
              return (
                <ControlCombobox
                  selectedValue={value}
                  displayValue={alternateName[display] ?? display}
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
                  setValue={(val: string) => {
                    field.onChange(val || null);
                  }}
                  items={models.map((model) => ({
                    label:
                      providerCapability?.models?.find((item) => item.id === model)?.label ?? model,
                    value: model,
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
        {hasWorkspaceBinding && (
          <div className="border-token-border-light bg-token-surface-primary mb-4 rounded-lg border p-4 text-left">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{localize('com_ui_glasshive_harness')}</div>
                <div className="text-token-text-secondary text-xs">
                  {localize('com_ui_glasshive_harness_description')}
                </div>
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-1 text-xs font-medium',
                  readinessStatus === 'ready'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                    : 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
                )}
                aria-live="polite"
              >
                {readinessLabel}
              </span>
            </div>
            <div className="text-token-text-secondary mb-3 flex items-start justify-between gap-3 text-xs">
              <span>{readinessDetail}</span>
              <button
                type="button"
                className="underline"
                onClick={() => readinessQuery.refetch()}
                disabled={readinessQuery.isFetching}
              >
                {localize('com_ui_glasshive_recheck')}
              </button>
            </div>
            <label
              className="mb-1 block text-sm font-medium"
              htmlFor={`${fields.parameters}-glasshive-workspace-mode`}
            >
              {localize('com_ui_glasshive_working_folder')}
            </label>
            <Controller
              name="glasshive_options.workspace.mode"
              control={control}
              render={({ field }) => (
                <select
                  {...field}
                  id={`${fields.parameters}-glasshive-workspace-mode`}
                  className="border-token-border-light bg-token-surface-primary mb-3 h-10 w-full rounded-lg border px-3"
                >
                  <option value="life">{localize('com_ui_glasshive_viventium_life')}</option>
                  <option value="custom">{localize('com_ui_glasshive_custom_server_path')}</option>
                </select>
              )}
            />
            {glassHiveOptions?.workspace?.mode === 'custom' && (
              <Controller
                name="glasshive_options.workspace.path"
                control={control}
                rules={{ required: true }}
                render={({ field, fieldState: { error } }) => (
                  <div className="mb-3">
                    <input
                      {...field}
                      value={field.value ?? ''}
                      aria-label={localize('com_ui_glasshive_custom_working_folder')}
                      placeholder={localize('com_ui_glasshive_path_placeholder')}
                      className={cn(
                        'border-token-border-light bg-token-surface-primary h-10 w-full rounded-lg border px-3',
                        error && 'border-red-500',
                      )}
                    />
                    <p className="text-token-text-secondary mt-1 text-xs">
                      {localize('com_ui_glasshive_path_description')}
                    </p>
                  </div>
                )}
              />
            )}
            <label
              className="mb-1 block text-sm font-medium"
              htmlFor={`${fields.parameters}-glasshive-access`}
            >
              {localize('com_ui_glasshive_access')}
            </label>
            <Controller
              name="glasshive_options.access"
              control={control}
              render={({ field }) => (
                <select
                  {...field}
                  id={`${fields.parameters}-glasshive-access`}
                  className="border-token-border-light bg-token-surface-primary h-10 w-full rounded-lg border px-3"
                >
                  <option value="full">{localize('com_ui_glasshive_full_access')}</option>
                  <option value="workspace">
                    {localize('com_ui_glasshive_workspace_writes_only')}
                  </option>
                </select>
              )}
            />
          </div>
        )}
        {(modelCapability?.effortChoices?.length ?? 0) > 0 && (
          <div className="mb-4">
            <label
              className="mb-1 block text-sm font-medium"
              htmlFor={`${fields.parameters}-effort`}
            >
              {localize('com_ui_glasshive_effort')}
            </label>
            <Controller
              name={`${fields.parameters}.reasoning_effort`}
              control={control}
              render={({ field }) => (
                <select
                  {...field}
                  value={field.value ?? modelCapability?.recommendedEffort ?? ''}
                  id={`${fields.parameters}-effort`}
                  className="border-token-border-light bg-token-surface-primary h-10 w-full rounded-lg border px-3"
                >
                  {modelCapability?.effortChoices.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                      {effort === modelCapability.recommendedEffort
                        ? ` (${localize('com_ui_glasshive_recommended')})`
                        : ''}
                    </option>
                  ))}
                </select>
              )}
            />
          </div>
        )}
      </div>
      <ModelParametersSection
        fieldName={fields.parameters}
        provider={provider}
        model={selectedModel ?? ''}
        title={parametersTitle}
        excludedParameterKeys={
          (modelCapability?.effortChoices?.length ?? 0) > 0 ? ['reasoning_effort'] : []
        }
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
