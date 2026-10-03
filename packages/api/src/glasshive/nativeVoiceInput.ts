import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';

const nativeInput = z.object({
  requestId: z.string().min(1).max(160),
  requestFingerprint: z.string().length(64),
  runId: z.string().min(1).max(160),
  attemptId: z.string().min(1).max(160),
  expiresAt: z.string().datetime({ offset: true }),
  prompt: z.string().min(1).max(8000),
  choices: z
    .array(z.object({ value: z.string().min(1).max(160), label: z.string().min(1).max(160) }))
    .min(1)
    .max(16),
});
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
      if (
        Date.parse(request.expiresAt) <= Date.now() ||
        !request.choices.some((choice) => choice.value === input)
      ) {
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
          input,
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
