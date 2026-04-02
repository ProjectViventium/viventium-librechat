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
import { Brain, ChevronDown, Plus, Trash2 } from 'lucide-react';
import {
  Label,
  Input,
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
import { useAgentsMapContext } from '~/Providers';
import { ESide } from '~/common';

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
  "activate": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}`;

const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  enabled: true,
  model: 'meta-llama/llama-4-scout-17b-16e-instruct', // Fast and cost-effective Groq model
  provider: 'groq',
  prompt: DEFAULT_ACTIVATION_PROMPT,
  confidence_threshold: 0.7,
  cooldown_ms: 5000,
  max_history: 10,
};

// Model options for activation detection (fast/cheap models recommended)
// Updated 2026-01-06: Based on latest Groq API models and web research
const MODEL_OPTIONS: OptionWithIcon[] = [
  // Standard Providers
  { label: 'GPT-4o Mini (OpenAI)', value: 'gpt-4o-mini|openai' },
  { label: 'Claude 3 Haiku (Anthropic)', value: 'claude-3-haiku-20240307|anthropic' },
  { label: 'Gemini 1.5 Flash (Google)', value: 'gemini-1.5-flash|google' },

  // Groq Models - Fast & Cost-Effective (Recommended for Activation)
  // Ultra-Fast & Budget-Friendly
  { label: 'Llama 3.1 8B Instant (Groq) ⚡', value: 'llama-3.1-8b-instant|groq' },
  { label: 'Groq Compound Mini (Groq) ⚡', value: 'groq/compound-mini|groq' },

  // Latest Llama 4 Models (2025)
  { label: 'Llama 4 Scout 17B (Groq) 🆕', value: 'meta-llama/llama-4-scout-17b-16e-instruct|groq' },
  { label: 'Llama 4 Maverick 17B (Groq) 🆕', value: 'meta-llama/llama-4-maverick-17b-128e-instruct|groq' },

  // High-Performance Options
  { label: 'Llama 3.3 70B Versatile (Groq)', value: 'llama-3.3-70b-versatile|groq' },
  { label: 'Groq Compound (Groq)', value: 'groq/compound|groq' },

  // Specialized Models
  { label: 'Qwen 3 32B (Groq)', value: 'qwen/qwen3-32b|groq' },
  { label: 'Kimi K2 Instruct (Groq)', value: 'moonshotai/kimi-k2-instruct|groq' },
  { label: 'Kimi K2 Instruct 0905 (Groq)', value: 'moonshotai/kimi-k2-instruct-0905|groq' },
];

interface CortexCardProps {
  cortex: BackgroundCortex;
  index: number;
  agentsMap: Record<string, any> | null;
  onUpdate: (index: number, updates: Partial<BackgroundCortex>) => void;
  onRemove: (index: number) => void;
}

const CortexCard: React.FC<CortexCardProps> = ({
  cortex,
  index,
  agentsMap,
  onUpdate,
  onRemove,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const agent = agentsMap?.[cortex.agent_id];

  const selectedModelValue = `${cortex.activation.model}|${cortex.activation.provider}`;

  const handleModelChange = (value: string) => {
    const [model, provider] = value.split('|');
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
    <div className="rounded-md border border-border-light bg-surface-secondary p-3">
      {/* Cortex Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {agent && (
            <MessageIcon
              message={{
                endpoint: EModelEndpoint.agents,
                isCreatedByUser: false,
              } as TMessage}
              agent={agent}
            />
          )}
          <span className="font-medium text-text-primary">
            {agent?.name || 'Unknown Agent'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded p-1 hover:bg-surface-tertiary"
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
              Activation Model (Fast/Low-cost recommended)
            </Label>
            <ControlCombobox
              isCollapsed={false}
              ariaLabel="Select activation model"
              selectedValue={selectedModelValue}
              setValue={handleModelChange}
              selectPlaceholder="Select model..."
              searchPlaceholder="Search models..."
              items={MODEL_OPTIONS}
              displayValue={
                MODEL_OPTIONS.find((m) => m.value === selectedModelValue)?.label ?? ''
              }
              className="h-9 w-full border-border-heavy text-sm"
              containerClassName="px-0"
            />
          </div>

          {/* Confidence Threshold */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs text-text-secondary">Confidence Threshold</Label>
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
              Cooldown (seconds)
            </Label>
            <Input
              id={`cooldown-${index}`}
              type="number"
              min={0}
              max={3600}
              value={cortex.activation.cooldown_ms / 1000}
              onChange={(e) =>
                updateActivation({ cooldown_ms: Number(e.target.value) * 1000 })
              }
              className="h-8 text-sm"
            />
          </div>

          {/* Max History */}
          <div>
            <Label htmlFor={`history-${index}`} className="mb-1 text-xs text-text-secondary">
              History Context (messages)
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
              Activation Prompt
            </Label>
            <Textarea
              id={`prompt-${index}`}
              value={cortex.activation.prompt}
              onChange={(e) => updateActivation({ prompt: e.target.value })}
              className="h-32 resize-none text-xs"
              placeholder="System prompt for deciding when to activate..."
            />
            <p className="mt-1 text-xs text-text-tertiary">
              Customize when this cortex should activate for this agent
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
  const agentsMap = useAgentsMapContext();

  const cortices = field.value || [];

  // Get list of available agents (exclude self and already-added cortices)
  const agents = useMemo(() => (agentsMap ? Object.values(agentsMap) : []), [agentsMap]);
  const addedCortexIds = useMemo(
    () => new Set(cortices.map((c) => c.agent_id)),
    [cortices],
  );

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
                  message={{
                    endpoint: EModelEndpoint.agents,
                    isCreatedByUser: false,
                  } as TMessage}
                  agent={agent}
                />
              ),
            }) as OptionWithIcon,
        ),
    [agents, currentAgentId, addedCortexIds],
  );

  const handleAddCortex = (agentId: string) => {
    if (!agentId || addedCortexIds.has(agentId)) return;

    const newCortex: BackgroundCortex = {
      agent_id: agentId,
      activation: { ...DEFAULT_ACTIVATION_CONFIG },
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
          <label className="font-semibold text-text-primary">Background Cortices</label>
          <HoverCardTrigger>
            <CircleHelpIcon className="h-4 w-4 text-text-tertiary" />
          </HoverCardTrigger>
          <span className="ml-auto text-xs text-text-tertiary">
            {cortices.length} cortex{cortices.length !== 1 ? 'es' : ''}
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
                onUpdate={handleUpdateCortex}
                onRemove={handleRemoveCortex}
              />
            ))}
          </div>
        )}

        {/* Add Cortex */}
        <div className="rounded-md border border-dashed border-border-light p-3">
          <Label className="mb-2 text-xs text-text-secondary">Add Background Cortex</Label>
          <ControlCombobox
            isCollapsed={false}
            ariaLabel="Select agent to add as cortex"
            selectedValue=""
            setValue={handleAddCortex}
            selectPlaceholder="Select an agent..."
            searchPlaceholder="Search agents..."
            items={selectableAgents}
            displayValue=""
            SelectIcon={<Plus className="h-4 w-4" />}
            className="h-10 w-full border-border-heavy"
            containerClassName="px-0"
          />
          <p className="mt-2 text-xs text-text-tertiary">
            Add agents as background cortices. Each will run in parallel, independently
            deciding whether to activate based on conversation context.
          </p>
        </div>
      </div>

      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <div className="space-y-2">
            <p className="text-sm font-medium">Background Cortices</p>
            <p className="text-sm text-text-secondary">
              Background cortices are agents that run in parallel, analyzing conversations
              and surfacing insights to this main agent.
            </p>
            <p className="text-sm text-text-secondary">
              Each cortex has its own activation settings - customize when each one should
              run based on confidence threshold and activation prompts.
            </p>
          </div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
};

export default BackgroundCorticesConfig;
