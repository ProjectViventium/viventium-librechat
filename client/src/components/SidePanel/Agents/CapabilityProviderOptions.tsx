/* === VIVENTIUM START ===
 * Feature: Capability-backed Agent provider options
 * Purpose: Keep readiness, workspace/access, and model-effort behavior identical whether a
 * provider is selected as the main model or an optional Voice Call LLM.
 * === VIVENTIUM END === */
import React, { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { request } from 'librechat-data-provider';
import type { TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { resolveCapabilityEffort } from './modelSelection';

export type CapabilityParameterField =
  | 'model_parameters'
  | 'voice_llm_model_parameters'
  | 'fallback_llm_model_parameters'
  | 'voice_fallback_llm_model_parameters';

type ProviderReadiness = {
  status: string;
  detail: string;
  models: Array<{
    id: string;
    readiness?: { status?: string; authentication?: string; detail?: string };
  }>;
};

type CapabilityProviderOptionsProps = {
  provider: string;
  model: string;
  parameterField: CapabilityParameterField;
  providerCapability?: TAgentProviderCapability;
};

export default function CapabilityProviderOptions({
  provider,
  model,
  parameterField,
  providerCapability,
}: CapabilityProviderOptionsProps) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();
  const parameters = useWatch({ control, name: parameterField });
  const glassHiveOptions = useWatch({ control, name: 'glasshive_options' });
  const hasWorkspaceBinding = providerCapability?.workspace_binding === true;
  const modelCapability = useMemo(
    () => providerCapability?.models?.find((candidate) => candidate.id === model),
    [model, providerCapability?.models],
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
    (item) => item.id === model,
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
    const effort = resolveCapabilityEffort(parameters?.reasoning_effort, modelCapability);
    if (effort && effort !== parameters?.reasoning_effort) {
      setValue(`${parameterField}.reasoning_effort` as never, effort as never, {
        shouldDirty: true,
      });
    }
  }, [modelCapability, parameterField, parameters?.reasoning_effort, setValue]);

  useEffect(() => {
    if (!hasWorkspaceBinding) {
      return;
    }
    if (!glassHiveOptions?.workspace?.mode) {
      setValue('glasshive_options.workspace.mode', 'life', { shouldDirty: true });
    }
    if (!glassHiveOptions?.access) {
      setValue('glasshive_options.access', providerCapability?.default_access ?? 'workspace', {
        shouldDirty: true,
      });
    }
  }, [
    glassHiveOptions?.access,
    glassHiveOptions?.workspace?.mode,
    hasWorkspaceBinding,
    providerCapability?.default_access,
    setValue,
  ]);

  const effortControl = (modelCapability?.effortChoices?.length ?? 0) > 0 && (
    <div className="model-panel-section mt-3">
      <label
        className="text-token-text-primary model-panel-label mb-1 block font-medium"
        htmlFor={`${parameterField}-effort`}
      >
        {localize('com_ui_glasshive_effort')}
      </label>
      <Controller
        name={`${parameterField}.reasoning_effort` as never}
        control={control}
        render={({ field }) => (
          <select
            {...field}
            value={field.value ?? modelCapability?.recommendedEffort ?? ''}
            id={`${parameterField}-effort`}
            className="border-token-border-light bg-token-surface-primary h-10 w-full rounded-lg border px-3"
          >
            {modelCapability?.effortChoices?.map((effort) => (
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
  );

  if (!hasWorkspaceBinding) {
    return effortControl || null;
  }

  return (
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
        htmlFor={`${parameterField}-glasshive-workspace-mode`}
      >
        {localize('com_ui_glasshive_working_folder')}
      </label>
      <Controller
        name="glasshive_options.workspace.mode"
        control={control}
        render={({ field }) => (
          <select
            {...field}
            id={`${parameterField}-glasshive-workspace-mode`}
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
        htmlFor={`${parameterField}-glasshive-access`}
      >
        {localize('com_ui_glasshive_access')}
      </label>
      <Controller
        name="glasshive_options.access"
        control={control}
        render={({ field }) => (
          <select
            {...field}
            id={`${parameterField}-glasshive-access`}
            className="border-token-border-light bg-token-surface-primary mb-3 h-10 w-full rounded-lg border px-3"
          >
            {providerCapability?.allow_full_access === true && (
              <option value="full">{localize('com_ui_glasshive_full_access')}</option>
            )}
            <option value="workspace">{localize('com_ui_glasshive_workspace_writes_only')}</option>
          </select>
        )}
      />
      <p className="text-token-text-secondary -mt-2 text-xs">
        {glassHiveOptions?.access === 'full'
          ? localize('com_ui_glasshive_full_access_warning')
          : localize('com_ui_glasshive_workspace_access_description')}
      </p>
      {providerCapability?.native_tools === true && (
        <p className="text-token-text-secondary mt-3 text-xs">
          {localize('com_ui_glasshive_native_tools_description')}
        </p>
      )}
      {effortControl}
    </div>
  );
}
