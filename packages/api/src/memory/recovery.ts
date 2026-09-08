/* === VIVENTIUM START === Conservative recovery of accepted work that provably never started. === */
import { createHash } from 'crypto';
import type { MemoryWriteSource } from '@librechat/data-schemas';
import { normalizeInteractionContext } from '../agents/interactionContext';

export function validatePendingMemoryRecovery({
  source, conversationId, admittedAt, configDigest, agentDigest, latestMutationAt, newerUserSource,
}: {
  source: MemoryWriteSource;
  conversationId: string;
  admittedAt: Date;
  configDigest: string;
  agentDigest: string;
  latestMutationAt?: number;
  newerUserSource: boolean;
}) {
  let context;
  try { context = normalizeInteractionContext(JSON.parse(source.interactionContextJson || 'null')); }
  catch { return { ok: false as const, reason: 'source_unavailable' }; }
  if (!source.input || typeof source.timeContext !== 'string' || !source.messageIds.length ||
    createHash('sha256').update(source.input).digest('hex') !== source.digest) {
    return { ok: false as const, reason: 'source_unavailable' };
  }
  if (!context || context.actor_kind !== 'external_user' || context.origin !== 'interactive' ||
    !['web', 'telegram'].includes(context.surface) || context.conversation_id !== conversationId) {
    return { ok: false as const, reason: 'authority_unavailable' };
  }
  if (source.configDigest !== configDigest || source.agentDigest !== agentDigest) {
    return { ok: false as const, reason: 'configuration_changed' };
  }
  if (newerUserSource) return { ok: false as const, reason: 'source_superseded' };
  if (!Number.isFinite(latestMutationAt) || !Number.isFinite(admittedAt.getTime()) ||
    Number(latestMutationAt) > admittedAt.getTime()) {
    return { ok: false as const, reason: 'memory_changed' };
  }
  return { ok: true as const, context };
}
