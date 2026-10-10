/* === VIVENTIUM START === Native recovery compares authored source without receipt metadata. === */
import { createHash } from 'node:crypto';
import type {
  IMainContinuityToolPair,
  IMainContinuityBackgroundInput,
} from '~/types/mainContinuityState';
const recordFrom = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Exact Main source projection; receipts and other non-source content do not change it. */
export function mainContinuityMessageEvidence(value: unknown) {
  const message = recordFrom(value);
  const inputs = normalizeMainBackgroundInputs(
    recordFrom(recordFrom(message.metadata).viventium).backgroundInputs,
  );
  if (inputs.length && message.isCreatedByUser !== false) throw invalidBackgroundInput();
  return {
    text: messageText(value),
    toolPairs: messageToolPairs(value),
    ...(inputs.length ? { backgroundInputs: inputs } : {}),
  };
}

function invalidBackgroundInput(): Error {
  return Object.assign(new Error('Accepted Main background input is invalid'), {
    code: 'source_context_unavailable',
  });
}

/** Validate exact source without clipping it or including mutable transport receipts. */
export function normalizeMainBackgroundInputs(value: unknown): IMainContinuityBackgroundInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw invalidBackgroundInput();
  const result = new Map<string, IMainContinuityBackgroundInput>();
  const hash = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const id = (value: unknown, max: number): value is string =>
    typeof value === 'string' && !!value.trim() && value.length <= max;
  let bytes = 0;
  for (const item of value) {
    const input = recordFrom(item);
    if (
      input.version !== 1 ||
      !id(input.invocationId, 160) ||
      !hash(input.deliveryId) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      Buffer.byteLength(input.text, 'utf8') > 65536 ||
      !hash(input.textSha256) ||
      createHash('sha256').update(input.text, 'utf8').digest('hex') !== input.textSha256 ||
      !Array.isArray(input.sources) ||
      !input.sources.length ||
      input.sources.length > 256
    )
      throw invalidBackgroundInput();
    const sources = input.sources.map((value) => {
      const source = recordFrom(value);
      if (
        !id(source.cortexId, 256) ||
        !hash(source.insightSha256) ||
        (source.cortexName !== undefined && !id(source.cortexName, 1024))
      )
        throw invalidBackgroundInput();
      return {
        cortexId: source.cortexId,
        insightSha256: source.insightSha256,
        ...(typeof source.cortexName === 'string' ? { cortexName: source.cortexName } : {}),
      };
    });
    const normalized: IMainContinuityBackgroundInput = {
      version: 1,
      invocationId: input.invocationId,
      deliveryId: input.deliveryId,
      text: input.text,
      textSha256: input.textSha256,
      sources,
    };
    const key = `${normalized.invocationId}\0${normalized.deliveryId}`;
    const previous = result.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized))
      throw invalidBackgroundInput();
    if (!previous) bytes += Buffer.byteLength(normalized.text, 'utf8');
    if (bytes > 8 * 1024 * 1024) throw invalidBackgroundInput();
    result.set(key, normalized);
  }
  return [...result.values()];
}

function messageText(messageValue: unknown): string {
  const message = recordFrom(messageValue);
  const parts: string[] = [];
  for (const value of Array.isArray(message.content) ? message.content : []) {
    const part = recordFrom(value);
    if (part.type !== 'text') continue;
    if (typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    const text = recordFrom(part.text);
    if (typeof text.value === 'string') parts.push(text.value);
  }
  return parts.length ? parts.join('\n').trim() : String(message.text || '').trim();
}

function messageToolPairs(messageValue: unknown): IMainContinuityToolPair[] {
  const message = recordFrom(messageValue);
  const pairs = new Map<string, IMainContinuityToolPair>();
  for (const value of Array.isArray(message.content) ? message.content : []) {
    const part = recordFrom(value);
    if (part.type !== 'tool_call') continue;
    const call = recordFrom(part.tool_call);
    const fn = recordFrom(call.function);
    const outcome = call.output ?? call.result ?? call.error;
    if (outcome === undefined || outcome === null) continue;
    const pair = {
      callId: String(call.id || call.tool_call_id || call.call_id || ''),
      toolName: String(call.name || fn.name || ''),
      outcome: typeof outcome === 'string' ? outcome : JSON.stringify(outcome),
    };
    pairs.set(pair.callId || `${pair.toolName}:${pairs.size}`, pair);
  }
  return Array.from(pairs.values());
}

/* === VIVENTIUM END === */
