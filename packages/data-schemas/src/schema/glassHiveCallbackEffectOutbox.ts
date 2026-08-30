/* === VIVENTIUM START ===
 * Feature: Generation-fenced GlassHive callback effect outbox.
 * Purpose: Own the durable scheduler-effect contract in the typed schema package.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import {
  GLASSHIVE_CALLBACK_EFFECT_OUTBOX_DESTINATIONS,
  GLASSHIVE_CALLBACK_EFFECT_OUTBOX_STATUSES,
} from '~/types/glassHiveCallbackEffectOutbox';
import type { IViventiumGlassHiveCallbackEffectOutbox } from '~/types/glassHiveCallbackEffectOutbox';

const glassHiveCallbackEffectOutboxSchema = new Schema<IViventiumGlassHiveCallbackEffectOutbox>(
  {
    outboxId: { type: String, required: true, unique: true, index: true },
    destination: {
      type: String,
      required: true,
      enum: GLASSHIVE_CALLBACK_EFFECT_OUTBOX_DESTINATIONS,
      index: true,
    },
    ownerId: { type: String, required: true, index: true },
    occurrenceKey: { type: String, required: true, index: true },
    summary: {
      requiredTotal: { type: Number, required: true },
      requiredTerminal: { type: Number, required: true },
      requiredFailed: { type: Number, required: true },
      allRequiredTerminal: { type: Boolean, required: true },
      state: { type: String, required: true },
    },
    terminalCallbackResultKey: { type: String, required: true, index: true },
    terminalCallbackAcceptedOperationId: { type: String, required: true },
    terminalCallbackId: { type: String, required: true },
    terminalCallbackResultDigest: { type: String, required: true },
    terminalCallbackResultRevision: { type: Number, required: true },
    terminalCallbackEffectGeneration: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      enum: GLASSHIVE_CALLBACK_EFFECT_OUTBOX_STATUSES,
      default: 'pending',
      index: true,
    },
    claimId: { type: String, default: '', index: true },
    claimExpiresAt: { type: Date, default: null, index: true },
    dispatchPermitId: { type: String, default: '', index: true },
    dispatchPermitGeneration: { type: Number, default: 0 },
    dispatchPermitExpiresAt: { type: Date, default: null, index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true },
);

glassHiveCallbackEffectOutboxSchema.index({
  destination: 1,
  status: 1,
  nextAttemptAt: 1,
  createdAt: 1,
});

export default glassHiveCallbackEffectOutboxSchema;
