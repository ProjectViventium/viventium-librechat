/* === VIVENTIUM START === The root Message retains its captured authored Main authority. === */
import type { MainContinuityIdentity } from './mainContinuity';

type CapturedIdentity = Pick<
  MainContinuityIdentity,
  'ownerId' | 'agentId' | 'stableAuthoritySha256'
>;
type MainContextStamp = Pick<CapturedIdentity, 'agentId' | 'stableAuthoritySha256'>;
/** Message metadata and Mongo update operands are open, untrusted documents. */
type Document = Record<string, unknown>;
export interface MainContextBinding {
  responseMessageId: string;
  identity: CapturedIdentity;
}

const path = 'metadata.viventium.mainContext';
const parentPath = (key: string) => key === 'metadata' || key === 'metadata.viventium';
const reservedPath = (key: string) => key === path || key.startsWith(path + '.');
const record = (value: unknown): Document =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Document) : {};
const atPath = (value: Document, key: string): unknown =>
  key.split('.').reduce<unknown>((current, part) => record(current)[part], value);

function stampFrom(value: unknown): MainContextStamp | undefined {
  const stamp = record(value);
  return typeof stamp.agentId === 'string' &&
    stamp.agentId.trim() &&
    typeof stamp.stableAuthoritySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(stamp.stableAuthoritySha256)
    ? { agentId: stamp.agentId, stableAuthoritySha256: stamp.stableAuthoritySha256 }
    : undefined;
}

export function capturedMainContextStamp(
  request: {
    user?: { id?: string };
    _viventiumAcceptedMainCompactionIdentityV1?: CapturedIdentity;
  },
  message: { messageId?: string; isCreatedByUser?: boolean },
  binding: MainContextBinding | undefined,
  restricted: boolean,
): MainContextStamp | undefined {
  const identity = request._viventiumAcceptedMainCompactionIdentityV1;
  if (
    restricted ||
    !identity ||
    !binding ||
    binding.identity !== identity ||
    identity.ownerId !== request.user?.id ||
    binding.responseMessageId !== message.messageId ||
    message.isCreatedByUser !== false
  )
    return undefined;
  return stampFrom(identity);
}

function parentValue(key: string, value: unknown, stamp?: MainContextStamp): unknown {
  if (!parentPath(key)) return value;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    if (!stamp) return value;
    return key === 'metadata' ? { viventium: { mainContext: stamp } } : { mainContext: stamp };
  }
  const result = { ...record(value) };
  if (key === 'metadata') {
    if (Object.prototype.hasOwnProperty.call(result, 'viventium') || stamp) {
      result.viventium = parentValue('metadata.viventium', result.viventium, stamp);
    }
  } else {
    delete result.mainContext;
    if (stamp) result.mainContext = stamp;
  }
  return result;
}

export function sanitizeMainContextUpdate(update: Document): Document {
  const result: Document = {};
  for (const [key, value] of Object.entries(update)) {
    if (reservedPath(key)) continue;
    if (!key.startsWith('$')) {
      result[key] = parentValue(key, value);
      continue;
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      result[key] = value;
      continue;
    }
    const operands: Document = {};
    for (const [field, operand] of Object.entries(record(value))) {
      if (reservedPath(field) || (key === '$rename' && reservedPath(String(operand)))) continue;
      operands[field] =
        key === '$set' || key === '$setOnInsert' ? parentValue(field, operand) : operand;
    }
    result[key] = operands;
  }
  return result;
}

export function mainContextUpdateNeedsRead(update: Document): boolean {
  return Object.entries(update).some(
    ([key, value]) =>
      parentPath(key) ||
      (key.startsWith('$') &&
        Object.entries(record(value)).some(
          ([field, operand]) =>
            parentPath(field) || (key === '$rename' && parentPath(String(operand))),
        )),
  );
}

/** Runs against the saved row inside the Message owner's existing mutation transaction. */
export function preserveMainContextUpdate(
  update: Document,
  previous: Document | null | undefined,
  captured?: MainContextStamp,
): Document {
  const saved = record(previous);
  const stamp = stampFrom(atPath(saved, path)) || captured;
  const result = sanitizeMainContextUpdate(update);
  let parentContainsStamp = false;
  const additionalSets: Document = {};
  const additionalUnsets: Document = {};
  const set = (field: string, value: unknown) => {
    additionalSets[field] = value;
  };
  for (const [key, value] of Object.entries(result)) {
    if (parentPath(key)) {
      result[key] = parentValue(key, value, stamp);
      parentContainsStamp = true;
      continue;
    }
    if (!key.startsWith('$')) continue;
    if (value == null || typeof value !== 'object' || Array.isArray(value)) continue;
    const operands = { ...record(value) };
    result[key] = operands;
    for (const [field, operand] of Object.entries(operands)) {
      if (key === '$rename' && (parentPath(field) || parentPath(String(operand)))) {
        if (
          typeof operand !== 'string' ||
          field === operand ||
          field.startsWith(operand + '.') ||
          operand.startsWith(field + '.')
        ) {
          throw new Error('main_context_parent_rename_conflict');
        }
        delete operands[field];
        const source = atPath(saved, field);
        if (source === undefined) continue;
        set(operand, parentValue(operand, parentValue(field, source), stamp));
        if (parentPath(field) && stamp) set(field, parentValue(field, {}, stamp));
        else additionalUnsets[field] = 1;
        parentContainsStamp = true;
        continue;
      }
      if (!parentPath(field)) continue;
      if (key === '$set' || key === '$setOnInsert') {
        operands[field] = parentValue(field, operand, stamp);
        parentContainsStamp = true;
      } else if (key === '$unset' && stamp) {
        delete operands[field];
        set(field, parentValue(field, {}, stamp));
        parentContainsStamp = true;
      } else if (key !== '$unset') {
        throw new Error('main_context_parent_update_unsupported');
      }
    }
  }
  if (captured && !stampFrom(atPath(saved, path)) && !parentContainsStamp) set(path, captured);
  if (Object.keys(additionalSets).length)
    result.$set = { ...record(result.$set), ...additionalSets };
  if (Object.keys(additionalUnsets).length)
    result.$unset = { ...record(result.$unset), ...additionalUnsets };
  return result;
}
/* === VIVENTIUM END === */
