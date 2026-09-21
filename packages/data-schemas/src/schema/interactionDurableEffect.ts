/* === VIVENTIUM START ===
 * Feature: Provider-neutral durable interaction-effect owner.
 * Purpose: Reserve each trusted tool-call effect in Mongo before provider mutation and retain its
 * result.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import {
  INTERACTION_DURABLE_EFFECT_KINDS,
  INTERACTION_DURABLE_EFFECT_STATES,
  INTERACTION_DURABLE_EFFECT_SURFACES,
} from '~/types/interactionDurableEffect';
import type { IInteractionDurableEffect } from '~/types/interactionDurableEffect';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EFFECT_KEY = /^effect_[a-f0-9]{64}$/;

const runtimeBindingSchema = new Schema(
  {
    candidateDigest: { type: String, maxlength: 128 },
    installedArtifactDigest: { type: String, maxlength: 128 },
    runtimeOwnerBindingHash: { type: String, maxlength: 128 },
  },
  { _id: false, strict: 'throw' },
);

const voiceAuthoritySchema = new Schema(
  {
    callSessionId: { type: String, required: true, minlength: 1, maxlength: 160 },
    voiceTurnId: { type: String, required: true, minlength: 1, maxlength: 160 },
    mode: { type: String, required: true, enum: ['call', 'wing'] },
    callModeRevision: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    speakerSessionRevision: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    segmentRevisionDigest: { type: String, required: true, match: SHA256 },
    ownerParticipantDigest: { type: String, required: true, match: SHA256 },
    engagementDigest: { type: String, match: SHA256 },
    engagementExpiresAt: { type: Date },
  },
  { _id: false, strict: 'throw' },
);

const deliveryAcknowledgementSchema = new Schema(
  {
    state: { type: String, required: true, enum: ['committed_effect'] },
    effectRef: { type: String, required: true, minlength: 1, maxlength: 256 },
    logicalTurnId: { type: String, required: true, minlength: 1, maxlength: 256 },
    revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    surface: { type: String, required: true, enum: ['telegram', 'voice'] },
    presentationRef: { type: String, maxlength: 256 },
    recordedAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

const interactionDurableEffectSchema = new Schema<IInteractionDurableEffect>(
  {
    schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
    effectKey: { type: String, required: true, match: EFFECT_KEY, immutable: true },
    ownerId: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
    conversationId: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 256,
      immutable: true,
    },
    logicalTurnId: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 256,
      immutable: true,
    },
    logicalTurnRevision: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    sourceEventId: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 512,
      immutable: true,
    },
    sourceRevision: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    responseMessageId: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 256,
      immutable: true,
    },
    presentationRevision: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    surface: {
      type: String,
      required: true,
      enum: INTERACTION_DURABLE_EFFECT_SURFACES,
      immutable: true,
    },
    effectOrdinal: {
      type: Number,
      required: true,
      enum: [0],
      validate: Number.isSafeInteger,
      immutable: true,
    },
    effectOccurrenceRef: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 256,
      immutable: true,
    },
    effectKind: {
      type: String,
      required: true,
      enum: INTERACTION_DURABLE_EFFECT_KINDS,
      immutable: true,
    },
    adapterId: { type: String, required: true, minlength: 1, maxlength: 120, immutable: true },
    routeId: { type: String, required: true, minlength: 1, maxlength: 120, immutable: true },
    operation: { type: String, required: true, minlength: 1, maxlength: 120, immutable: true },
    canonicalArgsSha256: { type: String, required: true, match: SHA256, immutable: true },
    voiceAuthorityRef: { type: String, maxlength: 160, immutable: true },
    voice: { type: voiceAuthoritySchema, immutable: true },
    providerIdempotencyKey: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 256,
      immutable: true,
    },
    providerIdempotencyMode: {
      type: String,
      required: true,
      enum: ['native_key', 'deterministic_reconciliation'],
      immutable: true,
    },
    runtimeBindingAtReserve: { type: runtimeBindingSchema, immutable: true },
    status: { type: String, required: true, enum: INTERACTION_DURABLE_EFFECT_STATES },
    claimRevision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    claimTokenHash: { type: String, required: true, match: SHA256 },
    claimExpiresAt: { type: Date },
    attemptCount: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    providerReceiptRef: { type: String, maxlength: 256 },
    providerResultSha256: { type: String, match: SHA256 },
    replayResult: { type: Schema.Types.Mixed },
    failureCode: { type: String, maxlength: 120 },
    committedAt: { type: Date },
    failedAt: { type: Date },
    lastTransitionAt: { type: Date, required: true },
    lastAttemptRuntimeBinding: { type: runtimeBindingSchema },
    deliveryAcknowledgement: { type: deliveryAcknowledgementSchema },
    transitionRevision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    createdAt: { type: Date, required: true, immutable: true },
  },
  {
    collection: 'viventium_interaction_durable_effects',
    strict: 'throw',
    versionKey: false,
  },
);

interactionDurableEffectSchema.index({ effectKey: 1 }, { unique: true });
interactionDurableEffectSchema.index(
  { ownerId: 1, effectOccurrenceRef: 1 },
  {
    unique: true,
    partialFilterExpression: { effectOccurrenceRef: { $type: 'string' } },
  },
);
interactionDurableEffectSchema.index({ adapterId: 1, providerIdempotencyKey: 1 }, { unique: true });
interactionDurableEffectSchema.index({ logicalTurnId: 1, logicalTurnRevision: 1, status: 1 });
interactionDurableEffectSchema.index({
  providerReceiptRef: 1,
  logicalTurnId: 1,
  logicalTurnRevision: 1,
  surface: 1,
  status: 1,
});
interactionDurableEffectSchema.index({ status: 1, claimExpiresAt: 1 });

export default interactionDurableEffectSchema;
