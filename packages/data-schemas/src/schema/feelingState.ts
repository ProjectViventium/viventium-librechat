import { Schema } from 'mongoose';
import { FEELING_STATE_BAND_IDS, FEELING_STATE_REACTION_CAUSES } from '~/types/feelingState';
import type { IFeelingState } from '~/types/feelingState';

const FeelingBandSchema = new Schema(
  {
    baseline: { type: Number, required: true, min: 0, max: 100 },
    current: { type: Number, required: true, min: 0, max: 100 },
    halfLifeMinutes: { type: Number, required: true, min: 1 },
    enabled: { type: Boolean, required: true, default: true },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const FeelingTrailSchema = new Schema(
  {
    timestamp: { type: Date, required: true },
    band: {
      type: String,
      required: true,
      enum: FEELING_STATE_BAND_IDS,
    },
    direction: { type: String, required: true, enum: ['up', 'down'] },
    strength: { type: String, required: true, enum: ['slight', 'clear', 'strong'] },
    cause: {
      type: String,
      required: true,
      enum: FEELING_STATE_REACTION_CAUSES,
    },
    sourceType: { type: String, required: true, enum: ['user_turn', 'manual', 'reset'] },
    before: { type: Number, required: true, min: 0, max: 100 },
    after: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

const FeelingReactionHealthSchema = new Schema(
  {
    status: {
      type: String,
      required: true,
      enum: ['never', 'running', 'healthy', 'skipped', 'degraded'],
      default: 'never',
    },
    lastStartedAt: { type: Date, default: null },
    lastCompletedAt: { type: Date, default: null },
    lastDurationMs: { type: Number, default: null },
    lastErrorClass: { type: String, default: null },
    lastErrorDetail: { type: String, default: null },
    lastSkipReason: { type: String, default: null },
    requestedProvider: { type: String, default: null },
    requestedModel: { type: String, default: null },
    requestedServiceTier: { type: String, default: null },
    lastUsedProvider: { type: String, default: null },
    lastUsedModel: { type: String, default: null },
    lastUsedServiceTier: { type: String, default: null },
    lastFallbackUsed: { type: Boolean, default: null },
    lastPrimaryErrorClass: { type: String, default: null },
  },
  { _id: false },
);

const FeelingInnerStateSchema = new Schema(
  {
    text: { type: String, required: true, minlength: 1, maxlength: 280 },
    generatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const feelingBandsDefinition = Object.fromEntries(
  FEELING_STATE_BAND_IDS.map((bandId) => [bandId, { type: FeelingBandSchema, required: true }]),
);

const feelingStateSchema = new Schema<IFeelingState>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    enabled: { type: Boolean, required: true, default: false },
    bands: feelingBandsDefinition,
    reactionInstruction: { type: String, default: '', maxlength: 4000 },
    reactionActivationMode: {
      type: String,
      required: true,
      enum: ['always', 'classified', 'disabled'],
      default: 'always',
    },
    innerState: { type: FeelingInnerStateSchema, default: null },
    trail: { type: [FeelingTrailSchema], default: [] },
    reactionHealth: { type: FeelingReactionHealthSchema, default: () => ({ status: 'never' }) },
    processedStimulusKeys: { type: [String], default: [] },
    version: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

export default feelingStateSchema;
