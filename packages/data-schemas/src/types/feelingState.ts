import { FEELING_BAND_IDS, FEELING_REACTION_CAUSES } from 'librechat-data-provider';
import type { FeelingReactionCause } from 'librechat-data-provider';
import type { Types } from 'mongoose';

export const FEELING_STATE_BAND_IDS = FEELING_BAND_IDS;
export const FEELING_STATE_REACTION_CAUSES = FEELING_REACTION_CAUSES;
export const MAX_FEELING_STATE_TRAIL_ENTRIES = 90;

export type FeelingBandId = (typeof FEELING_STATE_BAND_IDS)[number];

export type FeelingBandRecord = {
  baseline: number;
  current: number;
  halfLifeMinutes: number;
  enabled: boolean;
  updatedAt: Date;
};

export type FeelingTrailRecord = {
  timestamp: Date;
  band: FeelingBandId;
  direction: 'up' | 'down';
  strength: 'slight' | 'clear' | 'strong';
  cause: FeelingReactionCause;
  sourceType: 'user_turn' | 'manual' | 'reset';
  before: number;
  after: number;
};

export type FeelingInnerStateRecord = {
  text: string;
  generatedAt: Date;
};

export interface IFeelingState {
  userId: Types.ObjectId | string;
  enabled: boolean;
  bands: Record<FeelingBandId, FeelingBandRecord>;
  reactionInstruction: string;
  reactionActivationMode: 'always' | 'classified' | 'disabled';
  innerState?: FeelingInnerStateRecord | null;
  trail: FeelingTrailRecord[];
  reactionHealth: {
    status: 'never' | 'running' | 'healthy' | 'skipped' | 'degraded';
    lastStartedAt?: Date | null;
    lastCompletedAt?: Date | null;
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
  processedStimulusKeys: string[];
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CreateFeelingStateParams = {
  userId: string;
  state: Omit<IFeelingState, 'userId' | 'createdAt' | 'updatedAt'>;
};

export type UpdateFeelingStateParams = {
  userId: string;
  expectedVersion: number;
  set: Record<string, unknown>;
  trailEntries?: FeelingTrailRecord[];
};

export type CommitFeelingReactionParams = UpdateFeelingStateParams & {
  stimulusKey: string;
  health: IFeelingState['reactionHealth'];
};
