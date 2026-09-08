/* === VIVENTIUM START === Native recovery compares authored source without receipt metadata. === */
import type { IMainContinuityToolPair } from '~/types/mainContinuityState';
const recordFrom = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Exact Main source projection; receipts and other non-source content do not change it. */
export function mainContinuityMessageEvidence(value: unknown) {
  return { text: messageText(value), toolPairs: messageToolPairs(value) };
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
