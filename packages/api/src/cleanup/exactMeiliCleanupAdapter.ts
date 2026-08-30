import { createHash, timingSafeEqual } from 'crypto';
import type { CleanupJsonValue, CleanupTargetRef, SearchCleanupAdapter } from './types';
import { ownerScopeSha256, targetSetSha256 } from './personalAccountCleanup';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

interface MeiliTask {
  taskUid?: number | null;
}

interface MeiliTaskResult {
  status?: string;
}

interface MeiliIndexLike {
  getDocument(id: string): Promise<unknown>;
  deleteDocuments(ids: string[]): Promise<MeiliTask>;
  waitForTask(
    taskUid: number,
    options?: { timeOutMs?: number; intervalMs?: number },
  ): Promise<MeiliTaskResult>;
}

interface MeiliClientLike {
  index(name: 'messages' | 'convos'): MeiliIndexLike;
}

function normalize(value: CleanupJsonValue): CleanupJsonValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<{ [key: string]: CleanupJsonValue }>((result, key) => {
        result[key] = normalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function sha256(value: CleanupJsonValue): string {
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)), 'utf8')
    .digest('hex');
}

function exact(left: string, right: string): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const typed = error as { code?: unknown; httpStatus?: unknown; status?: unknown };
  return typed.code === 'document_not_found' || typed.httpStatus === 404 || typed.status === 404;
}

function validateTargets(targets: CleanupTargetRef[]): CleanupTargetRef[] {
  if (!Array.isArray(targets) || targets.length > 10_000) {
    throw new Error('cleanup_search_targets_invalid');
  }
  const seen = new Set<string>();
  return targets.map((target) => {
    if (!['message', 'conversation'].includes(target?.kind)) {
      throw new Error('cleanup_search_target_kind_invalid');
    }
    if (!SAFE_ID.test(String(target.resourceId || ''))) {
      throw new Error('cleanup_search_target_id_invalid');
    }
    const key = `${target.kind}\0${target.resourceId}`;
    if (seen.has(key)) throw new Error('cleanup_search_target_duplicate');
    seen.add(key);
    return { kind: target.kind, resourceId: target.resourceId };
  });
}

function indexName(target: CleanupTargetRef): 'messages' | 'convos' {
  return target.kind === 'message' ? 'messages' : 'convos';
}

export function meiliCleanupDocumentId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error('cleanup_search_target_id_invalid');
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `m_${encoded}`;
}

async function readDocument(index: MeiliIndexLike, id: string): Promise<unknown | null> {
  try {
    return await index.getDocument(id);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function createExactMeiliCleanupAdapter(
  client: MeiliClientLike,
  options: { taskTimeoutMs?: number; taskIntervalMs?: number } = {},
): SearchCleanupAdapter {
  const taskTimeoutMs = options.taskTimeoutMs ?? 30_000;
  const taskIntervalMs = options.taskIntervalMs ?? 50;

  async function verifyAbsent(input: { ownerId: string; targets: CleanupTargetRef[] }) {
    ownerScopeSha256(input.ownerId);
    const targets = validateTargets(input.targets);
    let verifiedCount = 0;
    for (const target of targets) {
      const document = await readDocument(
        client.index(indexName(target)),
        meiliCleanupDocumentId(target.resourceId),
      );
      if (document == null) verifiedCount += 1;
    }
    return { verifiedCount };
  }

  return {
    async reconcileExact(input) {
      const scope = ownerScopeSha256(input.ownerId);
      const targets = validateTargets(input.targets);
      const grouped = new Map<'messages' | 'convos', string[]>();

      for (const target of targets) {
        const name = indexName(target);
        const id = meiliCleanupDocumentId(target.resourceId);
        const index = client.index(name);
        const document = (await readDocument(index, id)) as { user?: unknown } | null;
        if (document == null) continue;
        if (!exact(String(document.user || ''), input.ownerId)) {
          throw new Error('cleanup_search_owner_mismatch');
        }
        grouped.set(name, [...(grouped.get(name) || []), id]);
      }

      const taskReceipts: CleanupJsonValue[] = [];
      for (const name of ['convos', 'messages'] as const) {
        const ids = grouped.get(name) || [];
        if (ids.length === 0) continue;
        const index = client.index(name);
        const task = await index.deleteDocuments(ids);
        if (!Number.isSafeInteger(task?.taskUid) || Number(task.taskUid) < 0) {
          throw new Error('cleanup_search_task_receipt_missing');
        }
        const completed = await index.waitForTask(Number(task.taskUid), {
          timeOutMs: taskTimeoutMs,
          intervalMs: taskIntervalMs,
        });
        if (completed?.status !== 'succeeded') {
          throw new Error('cleanup_search_task_failed');
        }
        taskReceipts.push({ index: name, taskUid: Number(task.taskUid), count: ids.length });
      }

      const absent = await verifyAbsent({ ownerId: input.ownerId, targets });
      if (absent.verifiedCount !== targets.length) {
        throw new Error('cleanup_search_residue');
      }
      return {
        status: 'verified',
        targetCount: targets.length,
        receiptSha256: sha256({
          contractVersion: 1,
          ownerScopeHash: scope,
          targetSetSha256: targetSetSha256(targets),
          taskReceipts,
          verifiedAbsent: targets.length,
        }),
      };
    },
    verifyAbsent,
  };
}
