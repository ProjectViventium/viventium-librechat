/**
 * === VIVENTIUM START ===
 * Feature: Background Cortices Configuration
 * Purpose: UI for managing background cortices on a main agent
 * Added: 2026-01-03
 *
 * This component allows users to:
 * - Add multiple background cortices (agents) to this main agent
 * - Configure activation settings for EACH cortex individually
 * - Each cortex can have different activation prompts, thresholds, etc.
 * === VIVENTIUM END ===
 */

import React, { useMemo, useState } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { Brain, ChevronDown, Plus, Trash2 } from 'lucide-react';
import {
  Label,
  Input,
  Switch,
  Slider,
  Textarea,
  HoverCard,
  CircleHelpIcon,
  HoverCardPortal,
  ControlCombobox,
  HoverCardContent,
  HoverCardTrigger,
} from '@librechat/client';
import type { TMessage, BackgroundCortex, ActivationConfig } from 'librechat-data-provider';
import type { ControllerRenderProps } from 'react-hook-form';
import type { AgentForm, OptionWithIcon } from '~/common';
import MessageIcon from '~/components/Share/MessageIcon';
import { useLocalize } from '~/hooks';
import { useAgentsMapContext } from '~/Providers';
import { ESide } from '~/common';
import {
  activationModelKey,
  buildActivationModelOptions,
  parseActivationModelKey,
  resolveDefaultActivationRoute,
} from './activationModelOptions';

interface BackgroundCorticesConfigProps {
  field: ControllerRenderProps<AgentForm, 'background_cortices'>;
  currentAgentId: string;
}

const DEFAULT_ACTIVATION_PROMPT = `You are an activation detector. Analyze the conversation and determine if this background cortex should run.

Consider:
- Is the topic relevant to this cortex's specialty?
- Does the user's message indicate a need for this type of analysis?
- Would running this background analysis provide value?

Respond with a JSON object:
{
  "should_activate": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}`;

const DEFAULT_ACTIVATION_CONFIG: Omit<ActivationConfig, 'model' | 'provider'> = {
  enabled: true,
  prompt: DEFAULT_ACTIVATION_PROMPT,
  confidence_threshold: 0.7,
  cooldown_ms: 5000,
  max_history: 10,
};

interface CortexCardProps {
  cortex: BackgroundCortex;
  index: number;
  agentsMap: Record<string, any> | null | undefined;
  models: Record<string, string[]>;
  onUpdate: (index: number, updates: Partial<BackgroundCortex>) => void;
  onRemove: (index: number) => void;
}

const CortexCard: React.FC<CortexCardProps> = ({
  cortex,
  index,
  agentsMap,
  models,
  onUpdate,
  onRemove,
}) => {
  const localize = useLocalize();
  const [isExpanded, setIsExpanded] = useState(false);
  const agent = agentsMap?.[cortex.agent_id];
  const isActivationEnabled = cortex.activation?.enabled !== false;

  const selectedModelValue = activationModelKey(cortex.activation);
  const modelOptions = useMemo(
    () => buildActivationModelOptions(models, cortex.activation),
    [cortex.activation, models],
  );

  const handleModelChange = (value: string) => {
    const { model, provider } = parseActivationModelKey(value);
    if (!model || !provider) return;
    onUpdate(index, {
      activation: { ...cortex.activation, model, provider },
    });
  };

  const updateActivation = (updates: Partial<ActivationConfig>) => {
    onUpdate(index, {
      activation: { ...cortex.activation, ...updates },
    });
  };

  return (
    <div
      className={`rounded-md border p-3 transition-colors ${
        isActivationEnabled
          ? 'border-border-light bg-surface-secondary'
          : 'border-border-light bg-surface-primary opacity-75'
      }`}
    >
      {/* Cortex Header */}
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {agent && (
            <MessageIcon
              message={
                {
                  endpoint: EModelEndpoint.agents,
                  isCreatedByUser: false,
                } as TMessage
              }
              agent={agent}
            />
          )}
          <span className="truncate font-medium text-text-primary">
            {agent?.name || localize('com_ui_unknown_agent')}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              isActivationEnabled
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-surface-tertiary text-text-secondary'
            }`}
          >
            {isActivationEnabled ? localize('com_ui_auto_on') : localize('com_ui_auto_off')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={isActivationEnabled}
            onCheckedChange={(checked) => updateActivation({ enabled: checked })}
            aria-label={localize('com_ui_toggle_automatic_activation_for', {
              0: agent?.name || localize('com_ui_background_cortex'),
            })}
          />
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded p-1 hover:bg-surface-tertiary"
            aria-label={`${
              isExpanded ? localize('com_ui_collapse') : localize('com_ui_expand')
            } ${agent?.name || localize('com_ui_background_cortex')}`}
            aria-expanded={isExpanded}
          >
            <ChevronDown
              size={16}
              className={`text-text-secondary transition-transform ${
                isExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="rounded p-1 text-red-500 hover:bg-red-500/10"
            aria-label={`${localize('com_ui_delete')} ${
              agent?.name || localize('com_ui_background_cortex')
            }`}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Expanded Activation Settings */}
      {isExpanded && (
        <div className="mt-3 space-y-4 border-t border-border-light pt-3">
          {/* Model Selection */}
          <div>
            <Label className="mb-1 text-xs text-text-secondary">
              {localize('com_ui_activation_model_recommended')}
            </Label>
            <ControlCombobox
              isCollapsed={false}
              ariaLabel={localize('com_ui_select_activation_model')}
              selectedValue={selectedModelValue}
              setValue={handleModelChange}
              selectPlaceholder={localize('com_ui_select_model')}
              searchPlaceholder={localize('com_ui_search_models')}
              items={modelOptions}
              displayValue={
                modelOptions.find((option) => option.value === selectedModelValue)?.label ??
                selectedModelValue
              }
              className="h-9 w-full border-border-heavy text-sm"
              containerClassName="px-0"
            />
          </div>

          {/* Auto Activation */}
          <div className="flex items-center justify-between">
            <Label htmlFor={`enabled-${index}`} className="text-xs text-text-secondary">
              {localize('com_ui_automatic_activation')}
            </Label>
            <Switch
              id={`enabled-${index}`}
              checked={isActivationEnabled}
              onCheckedChange={(checked) => updateActivation({ enabled: checked })}
              aria-label={localize('com_ui_automatic_activation_for', {
                0: agent?.name || localize('com_ui_background_cortex'),
              })}
            />
          </div>

          {/* Confidence Threshold */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs text-text-secondary">
                {localize('com_ui_confidence_threshold')}
              </Label>
              <span className="text-xs font-medium text-text-primary">
                {Math.round(cortex.activation.confidence_threshold * 100)}%
              </span>
            </div>
            <Slider
              aria-label="Confidence threshold"
              value={[cortex.activation.confidence_threshold * 100]}
              onValueChange={([val]) => updateActivation({ confidence_threshold: val / 100 })}
              min={0}
              max={100}
              step={5}
              className="w-full"
            />
          </div>

          {/* Cooldown */}
          <div>
            <Label htmlFor={`cooldown-${index}`} className="mb-1 text-xs text-text-secondary">
              {localize('com_ui_cooldown_seconds')}
            </Label>
            <Input
              id={`cooldown-${index}`}
              type="number"
              min={0}
              max={3600}
              value={cortex.activation.cooldown_ms / 1000}
              onChange={(e) => updateActivation({ cooldown_ms: Number(e.target.value) * 1000 })}
              className="h-8 text-sm"
            />
          </div>

          {/* Max History */}
          <div>
            <Label htmlFor={`history-${index}`} className="mb-1 text-xs text-text-secondary">
              {localize('com_ui_history_context_messages')}
            </Label>
            <Input
              id={`history-${index}`}
              type="number"
              min={1}
              max={50}
              value={cortex.activation.max_history}
              onChange={(e) => updateActivation({ max_history: Number(e.target.value) })}
              className="h-8 text-sm"
            />
          </div>

          {/* Activation Prompt */}
          <div>
            <Label htmlFor={`prompt-${index}`} className="mb-1 text-xs text-text-secondary">
              {localize('com_ui_activation_prompt')}
            </Label>
            <Textarea
              id={`prompt-${index}`}
              value={cortex.activation.prompt}
              onChange={(e) => updateActivation({ prompt: e.target.value })}
              className="h-32 resize-none text-xs"
              placeholder={localize('com_ui_activation_prompt_placeholder')}
            />
            <p className="mt-1 text-xs text-text-tertiary">
              {localize('com_ui_activation_prompt_hint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

const BackgroundCorticesConfig: React.FC<BackgroundCorticesConfigProps> = ({
  field,
  currentAgentId,
}) => {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const modelsQuery = useGetModelsQuery({ refetchOnMount: 'always' });
  const models = useMemo(() => modelsQuery.data ?? {}, [modelsQuery.data]);

  const cortices = useMemo(() => field.value || [], [field.value]);
  const defaultActivationRoute = useMemo(
    () => resolveDefaultActivationRoute(cortices, models),
    [cortices, models],
  );
  const canAddCortex = Boolean(activationModelKey(defaultActivationRoute));
  const activeCortexCount = cortices.filter(
    (cortex) => cortex.activation?.enabled !== false,
  ).length;

  // Get list of available agents (exclude self and already-added cortices)
  const agents = useMemo(() => (agentsMap ? Object.values(agentsMap) : []), [agentsMap]);
  const addedCortexIds = useMemo(() => new Set(cortices.map((c) => c.agent_id)), [cortices]);

  const selectableAgents = useMemo(
    () =>
      agents
        .filter((agent) => agent?.id !== currentAgentId && !addedCortexIds.has(agent?.id ?? ''))
        .map(
          (agent) =>
            ({
              label: agent?.name || '',
              value: agent?.id || '',
              icon: (
                <MessageIcon
                  message={
                    {
                      endpoint: EModelEndpoint.agents,
                      isCreatedByUser: false,
                    } as TMessage
                  }
                  agent={agent}
                />
              ),
            }) as OptionWithIcon,
        ),
    [agents, currentAgentId, addedCortexIds],
  );

  const handleAddCortex = (agentId: string) => {
    if (!agentId || addedCortexIds.has(agentId)) return;

    const route = defaultActivationRoute;
    if (!route.model || !route.provider) return;
    const routeTemplate = cortices.find(
      (cortex) => activationModelKey(cortex.activation) === activationModelKey(route),
    );
    const fallbacks = routeTemplate?.activation?.fallbacks?.map((fallback) => ({ ...fallback }));
    const activationFailureVisibility = routeTemplate?.activation?.activation_failure_visibility;
    const newCortex: BackgroundCortex = {
      agent_id: agentId,
      activation: {
        ...DEFAULT_ACTIVATION_CONFIG,
        ...route,
        ...(fallbacks?.length ? { fallbacks } : {}),
        ...(activationFailureVisibility
          ? { activation_failure_visibility: activationFailureVisibility }
          : {}),
      },
    };

    field.onChange([...cortices, newCortex]);
  };

  const handleUpdateCortex = (index: number, updates: Partial<BackgroundCortex>) => {
    const updated = [...cortices];
    updated[index] = { ...updated[index], ...updates };
    field.onChange(updated);
  };

  const handleRemoveCortex = (index: number) => {
    const updated = cortices.filter((_, i) => i !== index);
    field.onChange(updated);
  };

  return (
    <HoverCard openDelay={50}>
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-purple-500" />
          <label className="font-semibold text-text-primary">
            {localize('com_ui_background_cortices')}
          </label>
          <HoverCardTrigger>
            <CircleHelpIcon className="h-4 w-4 text-text-tertiary" />
          </HoverCardTrigger>
          <span className="ml-auto text-xs text-text-tertiary">
            {localize('com_ui_background_cortices_count', {
              0: activeCortexCount,
              1: cortices.length,
            })}
          </span>
        </div>

        {/* Cortex List */}
        {cortices.length > 0 && (
          <div className="space-y-2">
            {cortices.map((cortex, index) => (
              <CortexCard
                key={cortex.agent_id}
                cortex={cortex}
                index={index}
                agentsMap={agentsMap}
                models={models}
                onUpdate={handleUpdateCortex}
                onRemove={handleRemoveCortex}
              />
            ))}
          </div>
        )}

        {/* Add Cortex */}
        <div className="rounded-md border border-dashed border-border-light p-3">
          <Label className="mb-2 text-xs text-text-secondary">
            {localize('com_ui_add_background_cortex')}
          </Label>
          <ControlCombobox
            isCollapsed={false}
            ariaLabel={localize('com_ui_select_agent_to_add_as_cortex')}
            selectedValue=""
            setValue={handleAddCortex}
            selectPlaceholder={localize('com_ui_select_agent')}
            searchPlaceholder={localize('com_ui_search_agents')}
            items={selectableAgents}
            displayValue=""
            SelectIcon={<Plus className="h-4 w-4" />}
            disabled={!canAddCortex}
            className="h-10 w-full border-border-heavy"
            containerClassName="px-0"
          />
          <p className="mt-2 text-xs text-text-tertiary">
            {localize('com_ui_add_background_cortex_hint')}
          </p>
        </div>
      </div>

      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <div className="space-y-2">
            <p className="text-sm font-medium">{localize('com_ui_background_cortices')}</p>
            <p className="text-sm text-text-secondary">
              {localize('com_ui_background_cortices_description')}
            </p>
            <p className="text-sm text-text-secondary">
              {localize('com_ui_background_cortices_settings_description')}
            </p>
            <p className="text-sm text-text-secondary">
              {localize('com_ui_background_cortices_auto_off_description')}
            </p>
          </div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
};

export default BackgroundCorticesConfig;
