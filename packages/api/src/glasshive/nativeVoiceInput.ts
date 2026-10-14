import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { nativeQuestionContent, nativeQuestionFormFromSchema } from './nativeWorkInput';

const nativeInputIdentity = z.object({
  requestId: z.string().min(1).max(160),
  requestFingerprint: z.string().length(64),
  runId: z.string().min(1).max(160),
  attemptId: z.string().min(1).max(160),
  expiresAt: z.string().datetime({ offset: true }),
  prompt: z.string().min(1).max(8000),
});
const nativePermissionInput = nativeInputIdentity.extend({
  kind: z.literal('permission').optional(),
  operationTitle: z.string().min(1).max(8000).optional(),
  choices: z
    .array(z.object({ value: z.string().min(1).max(160), label: z.string().min(1).max(160) }))
    .min(1)
    .max(16),
});
const nativeQuestionInput = nativeInputIdentity
  .extend({
    kind: z.literal('question'),
    requestedSchema: z.unknown(),
  })
  .refine((value) => nativeQuestionFormFromSchema(value.requestedSchema) !== null);
const nativeInput = z.union([nativePermissionInput, nativeQuestionInput]);
const nativeState = z.object({
  version: z.literal(1),
  state: z.string(),
  pending: z.array(nativeInput).max(32),
});
export type NativeVoiceInput = z.infer<typeof nativeInput>;

export function createNativeVoiceInputClient({
  baseURL,
  apiKey,
  userId,
  fetchImpl = fetch,
}: {
  baseURL: string;
  apiKey: string;
  userId: string;
  fetchImpl?: typeof fetch;
}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'X-Viventium-User-Id': userId,
    'Content-Type': 'application/json',
  };
  const url = (key: string) =>
    `${baseURL.replace(/\/$/, '')}/requests/by-idempotency/${encodeURIComponent(key)}/native-input`;
  return {
    async isCurrent(key: string, request: NativeVoiceInput) {
      if (!key || Date.parse(request.expiresAt) <= Date.now()) return false;
      const response = await fetchImpl(url(key), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return false;
      const parsed = nativeState.safeParse(await response.json());
      if (
        !parsed.success ||
        ['completed', 'failed', 'cancelled', 'unsupported'].includes(parsed.data.state)
      )
        return false;
      return parsed.data.pending.some(
        (pending) =>
          Date.parse(pending.expiresAt) > Date.now() &&
          ['requestId', 'requestFingerprint', 'runId', 'attemptId', 'expiresAt', 'prompt'].every(
            (field) =>
              pending[field as keyof NativeVoiceInput] === request[field as keyof NativeVoiceInput],
          ) &&
          (pending.kind || 'permission') === (request.kind || 'permission'),
      );
    },
    async poll({
      key,
      signal,
      isActive,
      onInput,
    }: {
      key: () => string;
      signal: AbortSignal;
      isActive: () => boolean;
      onInput: (input: NativeVoiceInput, key: string) => void;
    }) {
      const seen = new Set<string>();
      let activeFingerprint: string | undefined;
      while (!signal.aborted && isActive()) {
        const requestKey = key();
        if (requestKey) {
          const response = await fetchImpl(url(requestKey), {
            headers,
            signal: (
              AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }
            ).any([signal, AbortSignal.timeout(4000)]),
            redirect: 'error',
          });
          if (response.ok) {
            const state = nativeState.parse(await response.json());
            if (['completed', 'failed', 'cancelled', 'unsupported'].includes(state.state)) return;
            if (
              state.pending.some(
                (input) =>
                  input.requestFingerprint === activeFingerprint &&
                  Date.parse(input.expiresAt) > Date.now(),
              )
            ) {
              await setTimeout(500, undefined, { signal, ref: false });
              continue;
            }
            activeFingerprint = undefined;
            for (const input of state.pending) {
              if (Date.parse(input.expiresAt) <= Date.now() || seen.has(input.requestFingerprint))
                continue;
              seen.add(input.requestFingerprint);
              activeFingerprint = input.requestFingerprint;
              onInput(input, requestKey);
              break;
            }
          } else if (response.status !== 404 && response.status !== 409) {
            throw new Error('native_input_unavailable');
          }
        }
        await setTimeout(500, undefined, { signal, ref: false });
      }
    },
    async submit(key: string, request: NativeVoiceInput, input: string) {
      if (Date.parse(request.expiresAt) <= Date.now()) {
        throw new Error('native_input_invalid_or_expired');
      }
      let nativeResponse = input;
      if (request.kind === 'question') {
        const form = nativeQuestionFormFromSchema(request.requestedSchema);
        let supplied: unknown;
        try {
          supplied = JSON.parse(input);
        } catch {
          throw new Error('native_input_invalid_or_expired');
        }
        const content = form && nativeQuestionContent(supplied, form);
        if (!content) throw new Error('native_input_invalid_or_expired');
        nativeResponse = JSON.stringify(content);
      } else if (!request.choices.some((choice) => choice.value === input)) {
        throw new Error('native_input_invalid_or_expired');
      }
      const response = await fetchImpl(url(key), {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
        body: JSON.stringify({
          version: 1,
          requestId: request.requestId,
          requestFingerprint: request.requestFingerprint,
          runId: request.runId,
          attemptId: request.attemptId,
          input: nativeResponse,
        }),
      });
      if (!response.ok) throw new Error('native_input_rejected');
      const result = (await response.json()) as {
        version?: number;
        accepted?: boolean;
        requestId?: string;
      };
      if (
        result.version !== 1 ||
        result.accepted !== true ||
        result.requestId !== request.requestId
      )
        throw new Error('native_input_not_acknowledged');
      return { accepted: true, phase: 'running' };
    },
  };
}
