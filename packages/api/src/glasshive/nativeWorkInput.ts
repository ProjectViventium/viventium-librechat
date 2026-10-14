/* === VIVENTIUM START ===
 * Feature: Native mission owner-input courier.
 * Purpose: Share exact response validation, bounded callback identity and current voice ownership.
 * === VIVENTIUM END === */

import { z } from 'zod';
import crypto from 'node:crypto';
import { canonicalizeGlassHiveCallbackRef } from '../trace/orchestrationTraceHooks';
import { sanitizeGlassHiveCallbackText } from './callbackSanitizer';
import type { VoiceWorkAuthorityBinding } from '../voice/engagementAuthority';

// Native question text is an exact wire key. Zod's record merger drops __proto__.
const exactNativeQuestionMap = <T extends z.ZodTypeAny>(field: T) =>
  z.custom<Record<string, z.infer<T>>>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([key, item]) => key.length > 0 && key.length <= 8000 && field.safeParse(item).success,
      ),
  );

export const nativeQuestionContentSchema = z
  .object({
    answers: exactNativeQuestionMap(z.array(z.string().min(1).max(160)).min(1).max(17)),
    annotations: exactNativeQuestionMap(
      z.object({ notes: z.string().min(1).max(8000) }).strict(),
    ).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value.answers).length >= 1 &&
      Object.keys(value.answers).length <= 16 &&
      Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536,
  );

export const nativeInputRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['question', 'permission']),
    requestId: z.string().min(1).max(512),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    runId: z.string().min(1).max(160),
    attemptId: z.string().min(1).max(160),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type NativeQuestionContent = z.infer<typeof nativeQuestionContentSchema>;
export const nativeQuestionFormSchema = z.object({
  questions: z
    .array(
      z.object({
        key: z.string().min(1).max(8000),
        label: z.string().min(1).max(8000),
        multiSelect: z.boolean(),
        options: z
          .array(z.object({ value: z.string().min(1).max(160), label: z.string().min(1).max(160) }))
          .min(1)
          .max(17),
      }),
    )
    .min(1)
    .max(16),
});
export type NativeQuestionForm = z.infer<typeof nativeQuestionFormSchema>;

export const nativeWorkInputResponseSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().min(1).max(512),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z
      .union([
        z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())])),
        nativeQuestionContentSchema,
      ])
      .optional(),
  })
  .strict();

/** Existing Queen input channel: exact clarification or native offered choice. */
export const nativeQueenInputResponseSchema = z.object({
  version: z.literal(1), requestId: z.string().min(1).max(512),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), action: z.literal('accept'),
  content: z.union([nativeQuestionContentSchema, z.object({optionId:z.string().min(1).max(160)}).strict()]),
}).strict();

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
        enumKinds: z.array(z.enum(['allow_once','allow_always','reject_once','reject_always']).nullable()).min(1).max(16).optional(),
        enumNames: z.array(z.string().min(1).max(160)).min(1).max(16),
        description: z.string().min(1).max(8000).optional(),
      }),
    }),
  }),
});

const questionSchema = nativeWorkInputBindingSchema.extend({
  kind: z.literal('question'),
  state: z.literal('pending'),
  mode: z.literal('form'),
  runtimeName: z.string().min(1).max(160),
  message: z.string().min(1).max(8000),
  requestedSchema: z.object({
    type: z.literal('object'),
    required: z.tuple([z.literal('answers')]),
    additionalProperties: z.literal(false),
    properties: z.object({
      answers: z.object({
        type: z.literal('object'),
        additionalProperties: z.literal(false),
        minProperties: z.literal(1),
        maxProperties: z.literal(16),
        properties: exactNativeQuestionMap(
          z.object({
            title: z.string().min(1).max(8000).optional(),
            type: z.literal('array'),
            uniqueItems: z.literal(true),
            minItems: z.literal(1),
            maxItems: z.number().int().min(1).max(17),
            items: z.object({
              type: z.literal('string'),
              enum: z.array(z.string().min(1).max(160)).min(1).max(17),
            }),
          }),
        ),
      }),
      annotations: z.object({
        type: z.literal('object'),
        additionalProperties: z.literal(false),
        properties: exactNativeQuestionMap(
          z.object({
            type: z.literal('object'),
            additionalProperties: z.literal(false),
            required: z.tuple([z.literal('notes')]),
            properties: z.object({
              notes: z.object({
                type: z.literal('string'),
                minLength: z.literal(1),
                maxLength: z.literal(8000),
              }),
            }),
          }),
        ),
      }),
    }),
  }),
});
const pendingRequestSchema = z.union([permissionSchema, questionSchema]);

export function nativeQuestionFormFromSchema(value: unknown): NativeQuestionForm | null {
  const parsed = questionSchema.shape.requestedSchema.safeParse(value);
  if (!parsed.success) return null;
  const properties = parsed.data.properties;
  const entries = Object.entries(properties.answers.properties);
  if (
    entries.length < 1 ||
    entries.length > 16 ||
    entries.some(
      ([key, field]) =>
        !key ||
        key.length > 8000 ||
        new Set(field.items.enum).size !== field.items.enum.length ||
        !field.items.enum.includes('Other') ||
        ![1, field.items.enum.length].includes(field.maxItems),
    ) ||
    Object.keys(properties.annotations.properties).length !== entries.length ||
    entries.some(([key]) => !Object.hasOwn(properties.annotations.properties, key))
  )
    return null;
  return {
    questions: entries.map(([key, field]) => ({
      key,
      label: sanitizeGlassHiveCallbackText(field.title || key),
      multiSelect: field.maxItems !== 1,
      options: field.items.enum.map((value) => ({
        value,
        label: sanitizeGlassHiveCallbackText(value),
      })),
    })),
  };
}

export function nativeQuestionForm(value: unknown): NativeQuestionForm | null {
  const parsed = questionSchema.safeParse(value);
  return parsed.success ? nativeQuestionFormFromSchema(parsed.data.requestedSchema) : null;
}

export function nativeQuestionContent(
  value: unknown,
  form: NativeQuestionForm,
): NativeQuestionContent | null {
  const parsed = nativeQuestionContentSchema.safeParse(value);
  if (!parsed.success) return null;
  const content = parsed.data;
  for (const [key, answers] of Object.entries(content.answers)) {
    const question = form.questions.find((item) => item.key === key);
    if (
      !question ||
      new Set(answers).size !== answers.length ||
      (!question.multiSelect && answers.length !== 1) ||
      answers.length > question.options.length ||
      answers.some((answer) => !question.options.some((option) => option.value === answer))
    )
      return null;
  }
  for (const key of Object.keys(content.annotations || {}))
    if (!Object.hasOwn(content.answers, key) || !content.answers[key]?.includes('Other'))
      return null;
  return content;
}

export type NativeWorkInputBinding = z.infer<typeof nativeWorkInputBindingSchema>;

const voiceMissionBindingSchema = nativeWorkInputBindingSchema.extend({
  inputKind: z.literal('question').optional(),
  questionForm: nativeQuestionFormSchema.optional(),
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

/** A question is presentation authority only; it cannot authorize its requested operation. */
export function nativeWorkInputPresentation(value: unknown, { allowExpired = false } = {}) {
  const parsed = z
    .object({
      event: z.literal('run.needs_input'),
      surface: z.literal('voice'),
      deliveryId: z.string().min(1).max(160),
      callbackId: z.string().regex(/^callback_sha256:[a-f0-9]{64}$/),
      callbackMessageId: z.string().min(1).max(160),
      userId: z.string().min(1).max(160),
      conversationId: z.string().min(1).max(160),
      voiceCallSessionId: z.string().min(1).max(160),
      voiceRequestId: z.string().min(1).max(160),
      originRef: z.string().min(1).max(160),
      workRef: z.string().min(1).max(160),
      workerId: z.string().min(1).max(160),
      runId: z.string().min(1).max(160),
      text: z.string().trim().min(1).max(8000),
      nativeInputBinding: nativeWorkInputBindingSchema,
    })
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data.runId !== parsed.data.nativeInputBinding.runId ||
    (!allowExpired && Date.parse(parsed.data.nativeInputBinding.expiresAt) <= Date.now())
  )
    return null;
  const authority = parsed.data;
  return {
    binding: authority.nativeInputBinding,
    identity: authority,
    digest: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(authority)).digest('hex'),
  };
}

export function nativeWorkInputQuestionText(pendingInput: unknown, pendingBinding: unknown) {
  const request = pendingRequestSchema.safeParse(pendingInput);
  if (!request.success) return null;
  const binding = nativeWorkInputBinding(pendingBinding, request.data.runId);
  if (
    !binding ||
    Date.parse(binding.expiresAt) <= Date.now() ||
    !Object.entries(binding).every(
      ([key, value]) => request.data[key as keyof NativeWorkInputBinding] === value,
    )
  )
    return null;
  if (request.data.kind === 'question')
    return nativeQuestionForm(request.data)
      ? sanitizeGlassHiveCallbackText(request.data.message) || null
      : null;
  const options = request.data.requestedSchema.properties.optionId;
  if (
    options.enum.length !== options.enumNames.length ||
    new Set(options.enum).size !== options.enum.length
  )
    return null;
  return sanitizeGlassHiveCallbackText(request.data.message) || null;
}

const nativeInputMessagePresentationSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['question', 'permission']),
  binding: nativeWorkInputBindingSchema,
});

/** Presentation is admitted from the native offer, without granting operation authority. */
export function nativeWorkInputMessagePresentation(pendingInput: unknown, runId: string) {
  const request = pendingRequestSchema.safeParse(pendingInput);
  const binding = nativeWorkInputBinding(pendingInput, runId);
  if (!request.success || !binding) return null;
  const text = nativeWorkInputQuestionText(request.data, binding);
  return text
    ? { text, presentation: { version: 1 as const, kind: request.data.kind, binding } }
    : null;
}

/** Historical presentations stay immutable when a later native request or status arrives. */
export function nativeWorkInputMessagePresentationMatches(left: unknown, right: unknown) {
  const a = nativeInputMessagePresentationSchema.safeParse(left);
  const b = nativeInputMessagePresentationSchema.safeParse(right);
  return (
    a.success &&
    b.success &&
    a.data.kind === b.data.kind &&
    Object.entries(a.data.binding).every(
      ([key, value]) => b.data.binding[key as keyof NativeWorkInputBinding] === value,
    )
  );
}

export function nativeWorkInputQuestionMatches(
  pendingInput: unknown,
  pendingBinding: unknown,
  text: string,
) {
  return nativeWorkInputQuestionText(pendingInput, pendingBinding) === text.trim();
}

interface NativeInputCurrentWork {
  workRef: string;
  state: string;
  pendingNativeInput?: unknown;
}
interface NativeInputCanonicalMessage {
  text: string;
  content?: Array<Record<string, unknown>>;
  metadata?: { viventium?: Record<string, unknown> };
}

/** Native request reads and canonical message recovery share the existing transactional courier. */
export function createNativeWorkInputPresentationService(dependencies: {
  requestWork(ownerId: string, workRef: string): Promise<NativeInputCurrentWork | null>;
  readMessage(
    filter: Record<string, unknown>,
    session: unknown,
  ): Promise<NativeInputCanonicalMessage | null>;
  updateMessage(
    filter: Record<string, unknown>,
    update: unknown,
    session: unknown,
  ): Promise<{ matchedCount: number }>;
  updateDelivery(
    filter: Record<string, unknown>,
    update: unknown,
    session: unknown,
  ): Promise<Record<string, unknown> | null>;
  fence<T>(operation: (session: unknown) => Promise<T>, row: Record<string, unknown>): Promise<T>;
}) {
  return async (row: Record<string, unknown>, session: unknown = null, recover = false) => {
    const authority = nativeWorkInputPresentation(row);
    if (!authority) return null;
    const identity = authority.identity;
    const messageFilter = {
      user: identity.userId,
      conversationId: identity.conversationId,
      messageId: identity.callbackMessageId,
      isCreatedByUser: false,
    };
    const [work, message] = await Promise.all([
      dependencies.requestWork(identity.userId, identity.workRef),
      dependencies.readMessage(messageFilter, session),
    ]);
    const text = nativeWorkInputQuestionText(work?.pendingNativeInput, authority.binding);
    const metadata = message?.metadata?.viventium;
    if (
      !work ||
      work.workRef !== identity.workRef ||
      work.state !== 'needs_input' ||
      !text ||
      !message ||
      metadata?.type !== 'glasshive_worker_callback' ||
      metadata.event !== identity.event ||
      metadata.originRef !== identity.originRef ||
      metadata.workRef !== identity.workRef ||
      metadata.workerId !== identity.workerId ||
      metadata.runId !== identity.runId ||
      canonicalizeGlassHiveCallbackRef(String(metadata.callbackId || '')) !== identity.callbackId ||
      metadata.voiceCallSessionId !== identity.voiceCallSessionId ||
      String(message.text || '').trim() !== String(identity.text || '').trim()
    )
      return null;
    if (text === String(identity.text || '').trim()) return { ...authority, delivery: row };
    if (!recover || !['pending', 'claimed'].includes(String(row.status)) || row.dispatchPermitId)
      return null;
    const repair = async (effectSession: unknown) => {
      const current = await dependencies.requestWork(identity.userId, identity.workRef);
      if (
        !current ||
        current.workRef !== identity.workRef ||
        current.state !== 'needs_input' ||
        nativeWorkInputQuestionText(current.pendingNativeInput, authority.binding) !== text
      )
        return null;
      const content: Array<Record<string, unknown>> = Array.isArray(message.content)
        ? message.content
        : [];
      const repairedContent = content.some((part) => part.type === 'text')
        ? content.map((part) => (part.type === 'text' ? { ...part, text } : part))
        : [...content, { type: 'text', text }];
      const changed = await dependencies.updateMessage(
        { ...messageFilter, text: message.text },
        { $set: { text, content: repairedContent } },
        effectSession,
      );
      if (changed.matchedCount !== 1) throw new Error('native_input_question_repair_changed');
      const updated = await dependencies.updateDelivery(
        {
          deliveryId: identity.deliveryId,
          userId: identity.userId,
          status: row.status,
          text: identity.text,
          'nativeInputBinding.requestFingerprint': authority.binding.requestFingerprint,
          dispatchPermitId: row.dispatchPermitId || '',
        },
        { $set: { text, fullText: text } },
        effectSession,
      );
      if (!updated) throw new Error('native_input_question_repair_changed');
      const recovered = nativeWorkInputPresentation(updated);
      return recovered ? { ...recovered, delivery: updated } : null;
    };
    return session ? repair(session) : dependencies.fence(repair, row);
  };
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
  binding: NativeWorkInputBinding & { inputKind?: 'question'; questionForm?: NativeQuestionForm },
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
  let content: { optionId: string } | NativeQuestionContent = { optionId: input.input };
  if (binding.inputKind === 'question') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.input);
    } catch {
      throw new Error('native_input_owner_control_required');
    }
    const questionContent =
      binding.questionForm && nativeQuestionContent(parsed, binding.questionForm);
    if (!questionContent) throw new Error('native_input_owner_control_required');
    content = questionContent;
  }
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
          content,
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
  const parsed = pendingRequestSchema.safeParse(pendingInput);
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
  const questionForm = request.kind === 'question' ? nativeQuestionForm(request) : null;
  if (request.kind === 'question' && !questionForm) return null;
  const options =
    request.kind === 'permission' ? request.requestedSchema.properties.optionId : null;
  if (
    request.runId !== task.owner.id ||
    (options &&
      (options.enum.length !== options.enumNames.length ||
        new Set(options.enum).size !== options.enum.length)) ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    return null;
  const ownerBinding = {
    ...binding,
    ...(questionForm ? { inputKind: 'question' as const, questionForm } : {}),
  };
  return {
    binding: {
      ...ownerBinding,
      taskId: task.taskId,
      workRef,
      userId: task.userId,
      callSessionId: task.callSessionId,
    },
    expiresAtMs: Date.parse(request.expiresAt),
    prompt: request.message,
    nativeInputRequest: {
      version: 1 as const,
      kind: request.kind,
      requestId: request.requestId,
      requestFingerprint: request.requestFingerprint,
      runId: request.runId,
      attemptId: request.attemptId,
      expiresAt: request.expiresAt,
    },
    ...(options
      ? {
          choices: options.enum.map((value, index) => ({ value, label: options.enumNames[index] })),
          ...(options.description ? { operationTitle: options.description } : {}),
        }
      : { questionForm }),
    async provideInput(input: NativeMissionInput) {
      if (Date.parse(request.expiresAt) <= Date.now()) {
        const retry = createNativeMissionVoiceAcknowledgement({
          binding: {
            ...ownerBinding,
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
      if (options && !options.enum.includes(input.input))
        throw new Error('native_input_owner_control_required');
      return deliverNativeMissionInput(ownerBinding, workRef, task, executeWorkAction, input);
    },
  };
}

/** The admitted Main can offer its exact pending native question once; this grants no answer authority. */
export function nativeInputSpeechOffer(task: unknown, input: unknown) {
  const source = z
    .object({
      taskId: z.string().min(1).max(160),
      userId: z.string().min(1).max(160),
      callSessionId: z.string().min(1).max(160),
      streamId: z.string().min(1).max(160),
      state: z.literal('needs_input'),
      suppressed: z.boolean().optional(),
      owner: z.object({
        kind: z.enum(['generation_job', 'remote_generation']),
        id: z.string().min(1).max(160),
      }),
      current: z.object({
        needsInput: z.object({
          prompt: z.string().min(1).max(8000),
          nativeInputRequest: nativeInputRequestSchema,
        }),
      }),
    })
    .safeParse(task);
  const request = z
    .object({
      userId: z.string(),
      callSessionId: z.string(),
      taskId: z.string(),
      streamId: z.string(),
      prompt: z.string().min(1).max(8000),
      nativeInputRequest: nativeInputRequestSchema,
    })
    .strict()
    .safeParse(input);
  if (!source.success || !request.success) return null;
  const value = source.data;
  const offered = request.data;
  if (
    value.suppressed ||
    value.owner.id !== value.streamId ||
    ['userId', 'callSessionId', 'taskId', 'streamId'].some(
      (key) => value[key as 'taskId'] !== offered[key as 'taskId'],
    ) ||
    value.current.needsInput.prompt !== offered.prompt ||
    JSON.stringify(value.current.needsInput.nativeInputRequest) !==
      JSON.stringify(offered.nativeInputRequest) ||
    Date.parse(offered.nativeInputRequest.expiresAt) <= Date.now()
  )
    return null;
  const requestKey = crypto.createHash('sha256').update(JSON.stringify(offered)).digest('hex');
  return {
    ...offered,
    requestKey,
    promptDigest: crypto.createHash('sha256').update(offered.prompt).digest('hex'),
  };
}
