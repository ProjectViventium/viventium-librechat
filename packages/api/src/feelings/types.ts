import {
  FEELING_BAND_IDS,
  FEELING_LEVEL_IDS,
  FEELING_MODEL_REACTION_CAUSES,
  FEELING_REACTION_CAUSES,
} from 'librechat-data-provider';

export {
  FEELING_BAND_IDS,
  FEELING_LEVEL_IDS,
  FEELING_MODEL_REACTION_CAUSES,
  FEELING_REACTION_CAUSES,
};

export const MAX_FEELING_TRAIL_ENTRIES = 90;
export const REACTION_TRAIL_CONTEXT_LIMIT = 10;
export const MAX_FEELING_INNER_STATE_CHARS = 280;
export const MAX_FEELING_RANGE_PROMPT_CHARS = 1200;

export type FeelingBandId = (typeof FEELING_BAND_IDS)[number];
export type FeelingLevelId = (typeof FEELING_LEVEL_IDS)[number];
export type FeelingsAgentScope = 'all_agents' | 'conscious_agent';
export type FeelingsReactionActivationMode = 'always' | 'classified' | 'disabled';
export type FeelingDirection = 'up' | 'down';
export type FeelingStrength = 'slight' | 'clear' | 'strong';
export type FeelingReactionCause = (typeof FEELING_REACTION_CAUSES)[number];

export type FeelingBandDefinition = {
  id: FeelingBandId;
  name: string;
  promptLabel: string;
  description: string;
  color: string;
  lowLabel: string;
  highLabel: string;
  baseline: number;
  halfLifeMinutes: number;
  levels: readonly [
    FeelingLevelDefinition,
    FeelingLevelDefinition,
    FeelingLevelDefinition,
    FeelingLevelDefinition,
    FeelingLevelDefinition,
  ];
};

export type FeelingLevelDefinition = {
  id: FeelingLevelId;
  min: number;
  max: number;
  word: string;
  instruction: string;
};

export type FeelingBandState = {
  baseline: number;
  current: number;
  halfLifeMinutes: number;
  enabled: boolean;
  updatedAt: string | Date;
};

export type FeelingBandsState = Record<FeelingBandId, FeelingBandState>;
export type FeelingRangePromptOverrides = Partial<
  Record<FeelingBandId, Partial<Record<FeelingLevelId, string>>>
>;

export type FeelingTrailEntry = {
  timestamp: string | Date;
  band: FeelingBandId;
  direction: FeelingDirection;
  strength: FeelingStrength;
  cause: FeelingReactionCause;
  sourceType: 'user_turn' | 'manual' | 'reset';
  before: number;
  after: number;
};

export type FeelingInnerState = {
  text: string;
  generatedAt: string | Date;
};

export type FeelingsReactionHealth = {
  status: 'never' | 'running' | 'healthy' | 'skipped' | 'degraded';
  lastStartedAt?: string | Date | null;
  lastCompletedAt?: string | Date | null;
  lastDurationMs?: number | null;
  lastErrorClass?: string | null;
  lastErrorDetail?: string | null;
  lastSkipReason?: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  requestedServiceTier?: string | null;
  lastUsedProvider?: string | null;
  lastUsedModel?: string | null;
  lastUsedServiceTier?: string | null;
  lastFallbackUsed?: boolean | null;
  lastPrimaryErrorClass?: string | null;
};

export type FeelingsRuntimeConfig = {
  available: boolean;
  defaultEnabled: boolean;
  agentScope: FeelingsAgentScope;
  bands: FeelingBandsState;
  reaction: {
    activationMode: FeelingsReactionActivationMode;
    provider: string;
    model: string;
    useResponsesApi: boolean;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    fast: boolean;
    serviceTier: 'auto' | 'default' | 'flex' | 'priority';
    timeoutMs: number;
    fallbackProvider: string;
    fallbackModel: string;
    activationProvider: string;
    activationModel: string;
    activationConfidenceThreshold: number;
    activationTimeoutMs: number;
  };
};

export type FeelingsReadSnapshot = {
  available: boolean;
  enabled: boolean;
  agentScope: FeelingsAgentScope;
  version: number;
  asOf: string;
  bands: FeelingBandsState;
  rangePromptOverrides: FeelingRangePromptOverrides;
  rangePromptOverrideCount: number;
  activeRangePromptOverrideCount: number;
  activeRangePromptOverrideChars: number;
  capsule: string;
  snapshotHash: string;
  reactionInstruction: string;
  reactionActivationMode: FeelingsReactionActivationMode;
  innerState: FeelingInnerState | null;
  trail: FeelingTrailEntry[];
  reactionHealth: FeelingsReactionHealth;
  cacheHit?: boolean;
};
