/* === VIVENTIUM START ===
 * Feature: Durable GlassHive terminal-result receiver CAS.
 * Purpose: Persist only the highest authenticated result identity for one trusted Core run scope.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import { GLASSHIVE_TERMINAL_CALLBACK_RESULT_STATES } from '~/types/glassHiveTerminalCallbackResult';
import type { IGlassHiveTerminalCallbackResult } from '~/types/glassHiveTerminalCallbackResult';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CALLBACK_ID = /^cb_terminal_[a-f0-9]{64}$/;
const OPERATION_ID = /^[a-f0-9]{32}$/;

const glassHiveTerminalCallbackResultSchema = new Schema<IGlassHiveTerminalCallbackResult>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, minlength: 1, maxlength: 512, immutable: true },
    originRef: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
    workRef: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
    workerId: { type: String, required: true, minlength: 1, maxlength: 160 },
    runId: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
    callbackId: { type: String, required: true, match: CALLBACK_ID },
    attemptNumber: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    resultState: {
      type: String,
      required: true,
      enum: GLASSHIVE_TERMINAL_CALLBACK_RESULT_STATES,
    },
    resultEndedAt: { type: String, required: true, minlength: 1, maxlength: 128 },
    resultRevision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    resultDigest: { type: String, required: true, match: SHA256 },
    acceptedOperationId: { type: String, required: true, match: OPERATION_ID },
    acceptedOperationGeneration: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    effectLeaseId: { type: String, required: false, match: OPERATION_ID },
    effectLeaseOperationId: { type: String, required: false, match: OPERATION_ID },
    effectLeaseGeneration: {
      type: Number,
      required: false,
      min: 1,
      validate: Number.isSafeInteger,
    },
    effectLeaseExpiresAt: { type: Date, required: false },
    acceptedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    collection: 'viventium_glasshive_callback_results',
    strict: 'throw',
    versionKey: false,
  },
);

glassHiveTerminalCallbackResultSchema.index({ ownerId: 1, originRef: 1, runId: 1 });
glassHiveTerminalCallbackResultSchema.index({ callbackId: 1 });

export default glassHiveTerminalCallbackResultSchema;
