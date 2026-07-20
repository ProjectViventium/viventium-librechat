export const FEELING_BAND_IDS = [
  'energy',
  'mood',
  'drive',
  'curiosity',
  'vigilance',
  'care',
  'connection',
  'openness',
  'play',
] as const;

export const FEELING_LEVEL_IDS = [
  'level_0',
  'level_1',
  'level_2',
  'level_3',
  'level_4',
] as const;

export const FEELING_MODEL_REACTION_CAUSES = [
  'playful_exchange',
  'connection_bid',
  'care_signal',
  'progress',
  'setback',
  'new_information',
  'uncertainty',
  'risk_or_boundary',
  'fatigue',
  'conflict',
  'praise',
  'loss',
  'surprise',
  'other',
] as const;

export const FEELING_REACTION_CAUSES = [
  ...FEELING_MODEL_REACTION_CAUSES,
  'manual_adjustment',
  'reset_to_nature',
] as const;

export const VISIBLE_FEELING_TRAIL_LIMIT = 10;
export const MAX_FEELING_RANGE_PROMPT_CHARS = 1200;

export type FeelingBandId = (typeof FEELING_BAND_IDS)[number];
export type FeelingLevelId = (typeof FEELING_LEVEL_IDS)[number];
export type FeelingReactionCause = (typeof FEELING_REACTION_CAUSES)[number];

export type FeelingLevelDefinition = {
  id: FeelingLevelId;
  min: number;
  max: number;
  word: string;
  instruction: string;
};

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
  levels: [
    FeelingLevelDefinition,
    FeelingLevelDefinition,
    FeelingLevelDefinition,
    FeelingLevelDefinition,
    FeelingLevelDefinition,
  ];
};

export type FeelingBandState = {
  baseline: number;
  current: number;
  halfLifeMinutes: number;
  enabled: boolean;
  updatedAt: string;
};

export type FeelingTrailEntry = {
  timestamp: string;
  band: FeelingBandId;
  direction: 'up' | 'down';
  strength: 'slight' | 'clear' | 'strong';
  cause: FeelingReactionCause;
  sourceType: 'user_turn' | 'manual' | 'reset';
  before: number;
  after: number;
};

export type FeelingsState = {
  available: boolean;
  enabled: boolean;
  agentScope: 'all_agents' | 'conscious_agent';
  version: number;
  asOf: string;
  bands: Record<FeelingBandId, FeelingBandState>;
  rangePromptOverrides: Partial<
    Record<FeelingBandId, Partial<Record<FeelingLevelId, string>>>
  >;
  rangePromptOverrideCount: number;
  activeRangePromptOverrideCount: number;
  activeRangePromptOverrideChars: number;
  capsule: string;
  snapshotHash: string;
  reactionInstruction: string;
  reactionActivationMode: 'always' | 'classified' | 'disabled';
  innerState: {
    text: string;
    generatedAt: string;
  } | null;
  trail: FeelingTrailEntry[];
  reactionHealth: {
    status: 'never' | 'running' | 'healthy' | 'skipped' | 'degraded';
    lastStartedAt?: string | null;
    lastCompletedAt?: string | null;
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
};

export type FeelingsResponse = {
  definitions: FeelingBandDefinition[];
  config: {
    available: boolean;
    agentScope: 'all_agents' | 'conscious_agent';
    reaction: {
      defaultInstruction: string;
      activationMode: 'always' | 'classified' | 'disabled';
      provider: string;
      model: string;
      useResponsesApi: boolean;
      reasoningEffort: string;
      fast: boolean;
      serviceTier: string;
      fallbackProvider: string;
      fallbackModel: string;
    };
  };
  state: FeelingsState;
};

export type UpdateFeelingsProfile = {
  expectedVersion: number;
  enabled?: boolean;
  reactionInstruction?: string;
  reactionActivationMode?: 'always' | 'classified' | 'disabled';
};

export type UpdateFeelingBand = {
  expectedVersion: number;
  baseline?: number;
  current?: number;
  halfLifeMinutes?: number;
  enabled?: boolean;
  reset?: boolean;
  rangePromptOverride?: {
    levelId: FeelingLevelId;
    instruction: string | null;
  };
};
