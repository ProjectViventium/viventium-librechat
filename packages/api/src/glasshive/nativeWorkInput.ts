/* === VIVENTIUM START ===
 * Feature: Native mission owner-input courier.
 * Purpose: Share exact response validation, bounded callback identity and current voice ownership.
 * === VIVENTIUM END === */

import { z } from 'zod';
import crypto from 'node:crypto';
import type { VoiceWorkAuthorityBinding } from '../voice/engagementAuthority';

export const nativeWorkInputResponseSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().min(1).max(512),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z
      .record(z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]))
      .optional(),
  })
  .strict();

const nativeWorkInputBindingSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(512),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().min(1).max(160),
  attemptId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160),
  expiresAt: z.string().datetime({ offset: true }),
});

const permissionSchema = nativeWorkInputBindingSchema.extend({
  kind: z.literal('permission'),
  state: z.literal('pending'),
  mode: z.literal('form'),
  runtimeName: z.string().min(1).max(160),
  message: z.string().min(1).max(8000),
  requestedSchema: z.object({
    type: z.literal('object'),
    required: z.tuple([z.literal('optionId')]),
    properties: z.object({
      optionId: z.object({
        type: z.literal('string'),
        enum: z.array(z.string().min(1).max(160)).min(1).max(16),
        enumNames: z.array(z.string().min(1).max(160)).min(1).max(16),
      }),
    }),
  }),
});

export type NativeWorkInputBinding = z.infer<typeof nativeWorkInputBindingSchema>;

const voiceMissionBindingSchema = nativeWorkInputBindingSchema.extend({
  taskId: z.string().min(1).max(160),
  workRef: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  userId: z.string().min(1).max(160),
  callSessionId: z.string().min(1).max(160),
});

export function nativeMissionVoiceBinding(
  value: unknown,
  task: {
    taskId: string;
    userId: string;
    callSessionId: string;
    owner?: { kind: string; id?: string };
  },
) {
  const parsed = voiceMissionBindingSchema.safeParse(value);
  if (!parsed.success || task.owner?.kind !== 'glasshive_run') return null;
  const binding = parsed.data;
  return binding.taskId === task.taskId &&
    binding.userId === task.userId &&
    binding.callSessionId === task.callSessionId &&
    binding.runId === task.owner.id
    ? binding
    : null;
}

export function retainedVoiceInputOperation(value: unknown) {
  const parsed = z
    .object({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      operationId: z.string().uuid(),
    })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function nativeWorkInputBinding(
  value: unknown,
  runId: string,
): NativeWorkInputBinding | null {
  const parsed = nativeWorkInputBindingSchema.safeParse(value);
  return parsed.success && parsed.data.runId === runId ? parsed.data : null;
}

interface NativeMissionInputAction {
  ownerId: string;
  workRef: string;
  action: 'resume';
  operationId: string;
  sourceSurface: 'voice';
  ownerInputControl: true;
  nativeInput: z.infer<typeof nativeWorkInputResponseSchema>;
  voiceAuthorityContext: { callSessionId: string; binding: VoiceWorkAuthorityBinding };
}

type NativeMissionTask = {
  taskId: string;
  userId: string;
  callSessionId: string;
  owner: { kind: string; id?: string };
};
type NativeMissionInput = {
  input: string;
  operationId: string;
  owner: { kind: string; id?: string };
  voiceAuthorityContext?: { callSessionId: string; binding: VoiceWorkAuthorityBinding };
  confirmationOperation?: ReturnType<typeof retainedVoiceInputOperation>;
};

async function deliverNativeMissionInput(
  binding: NativeWorkInputBinding,
  workRef: string,
  task: NativeMissionTask,
  executeWorkAction: (input: NativeMissionInputAction) => Promise<unknown>,
  input: NativeMissionInput,
) {
  if (
    input.owner.kind !== task.owner.kind ||
    input.owner.id !== binding.runId ||
    input.voiceAuthorityContext?.callSessionId !== task.callSessionId ||
    input.voiceAuthorityContext.binding.callSessionId !== task.callSessionId ||
    input.voiceAuthorityContext.binding.userId !== task.userId
  )
    throw new Error('native_input_owner_control_required');
  const result = z
    .object({ status: z.string(), confirmationPending: z.boolean().optional() })
    .parse(
      await executeWorkAction({
        ownerId: task.userId,
        workRef,
        action: 'resume',
        operationId: input.operationId,
        sourceSurface: 'voice',
        ownerInputControl: true,
        nativeInput: {
          version: 1,
          requestId: binding.requestId,
          requestFingerprint: binding.requestFingerprint,
          action: 'accept',
          content: { optionId: input.input },
        },
        voiceAuthorityContext: input.voiceAuthorityContext,
      }),
    );
  if (result.status === 'pending' && result.confirmationPending === true)
    return { accepted: false, confirmationPending: true };
  if (
    !['accepted', 'already_accepted'].includes(result.status) ||
    result.confirmationPending === true
  )
    throw new Error('native_input_not_acknowledged');
  return { accepted: true, phase: 'running' };
}

export function createNativeMissionVoiceAcknowledgement({
  binding: value,
  operation: operationValue,
  task,
  executeWorkAction,
}: {
  binding: unknown;
  operation: unknown;
  task: NativeMissionTask;
  executeWorkAction(input: NativeMissionInputAction): Promise<unknown>;
}) {
  const binding = nativeMissionVoiceBinding(value, task);
  const operation = retainedVoiceInputOperation(operationValue);
  if (!binding || !operation) return null;
  return {
    binding,
    async provideInput(input: NativeMissionInput) {
      if (
        input.operationId !== operation.operationId ||
        crypto.createHash('sha256').update(input.input).digest('hex') !== operation.hash
      )
        throw new Error('native_input_confirmation_conflict');
      return deliverNativeMissionInput(binding, binding.workRef, task, executeWorkAction, input);
    },
  };
}

export function createNativeMissionVoiceInput({
  pendingInput,
  pendingBinding,
  workRef,
  task,
  executeWorkAction,
}: {
  pendingInput: unknown;
  pendingBinding: unknown;
  workRef: string;
  task: {
    taskId: string;
    userId: string;
    callSessionId: string;
    owner: { kind: string; id?: string };
  };
  executeWorkAction(input: NativeMissionInputAction): Promise<unknown>;
}) {
  const parsed = permissionSchema.safeParse(pendingInput);
  if (!parsed.success || task.owner.kind !== 'glasshive_run' || !workRef) return null;
  const request = parsed.data;
  const binding = nativeWorkInputBinding(pendingBinding, request.runId);
  if (
    !binding ||
    Object.entries(binding).some(
      ([key, value]) => request[key as keyof NativeWorkInputBinding] !== value,
    )
  )
    return null;
  const options = request.requestedSchema.properties.optionId;
  if (
    request.runId !== task.owner.id ||
    options.enum.length !== options.enumNames.length ||
    new Set(options.enum).size !== options.enum.length ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    return null;
  return {
    binding: {
      ...binding,
      taskId: task.taskId,
      workRef,
      userId: task.userId,
      callSessionId: task.callSessionId,
    },
    expiresAtMs: Date.parse(request.expiresAt),
    prompt: request.message,
    choices: options.enum.map((value, index) => ({ value, label: options.enumNames[index] })),
    async provideInput(input: NativeMissionInput) {
      if (Date.parse(request.expiresAt) <= Date.now()) {
        const retry = createNativeMissionVoiceAcknowledgement({
          binding: {
            ...binding,
            taskId: task.taskId,
            workRef,
            userId: task.userId,
            callSessionId: task.callSessionId,
          },
          operation: input.confirmationOperation,
          task,
          executeWorkAction,
        });
        if (!retry) throw new Error('native_input_owner_control_required');
        return retry.provideInput(input);
      }
      if (!options.enum.includes(input.input))
        throw new Error('native_input_owner_control_required');
      return deliverNativeMissionInput(binding, workRef, task, executeWorkAction, input);
    },
  };
}
