import { isDeclaredConversationOrchestrator } from './conversationOrchestration';
import { normalizeWorkDeliveryScope } from './workDeliveryScope';
import type { WorkDeliveryScope } from './workDeliveryScope';
import { nativeQuestionForm, nativeWorkInputBinding, nativeWorkInputQuestionText } from './nativeWorkInput';
import { sanitizeGlassHiveCallbackText } from './callbackSanitizer';

const COLD_WAIT_MS = 100;
const MAX_CONTEXT_BYTES = 16 * 1024;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

interface WorkItem {
  workRef: string;
  title?: string;
  state?: string;
  updatedAt?: string;
  actions?: string[];
  delivery?: { state?: string };
  deliveryScope?: WorkDeliveryScope;
  attention?: { kind?: string; code?: string };
  pendingNativeInput?: unknown;
}

interface WorkSnapshot {
  snapshot?: string;
  work?: WorkItem[] | null;
  overflowCount?: number | null;
}

interface ContextUser {
  id?: string;
  _id?: { toString(): string } | string;
  personalization?: { orchestration_mode?: 'parallel' | 'focused'; parallel_work_known?: boolean };
}

interface ContextRequest {
  user?: ContextUser;
  _viventiumParallelWorkTurnAvailable?: boolean;
  _viventiumParallelWorkTurnReadiness?: { status?: string; reason?: string };
  _viventiumActiveWorkContext?: { scope: string; promise: Promise<WorkSnapshot | null> };
}

interface ContextAgent {
  glasshive_options?: { orchestration?: { parallel_available?: boolean } };
}

interface ContextDependencies {
  getActiveWorkSnapshot(input: { ownerId: string; timeoutMs: number }): Promise<WorkSnapshot>;
  preferredMode(user?: ContextUser): 'parallel' | 'focused';
  tenantId(): string;
}

const unavailable = (): WorkSnapshot => ({
  snapshot: 'unavailable',
  work: null,
  overflowCount: null,
});
const text = (value: string | undefined, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : '';
const attention = (item: WorkItem) => item.state === 'needs_input' || item.state === 'stopping';
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** Informational native form only; the existing work action still reads its current authority. */
export function projectCurrentNativeWorkInput(item: WorkItem, snapshot: string | undefined) {
  if (snapshot !== 'fresh' || item.state !== 'needs_input') return null;
  const pending = record(item.pendingNativeInput);
  if (typeof pending.runId !== 'string') return null;
  const binding = nativeWorkInputBinding(pending, pending.runId);
  const message = nativeWorkInputQuestionText(pending, pending);
  if (!binding || !message) return null;
  if (pending.kind === 'question') {
    const questionForm = nativeQuestionForm(pending);
    return questionForm ? { ...binding, kind: 'question' as const, message, questionForm } : null;
  }
  const option = record(record(record(pending.requestedSchema).properties).optionId);
  const values = option.enum as string[];
  const labels = option.enumNames as string[];
  const kinds = option.enumKinds as Array<string | null> | undefined;
  if (!kinds || kinds.length !== values.length) return null;
  return {
    ...binding, kind: 'permission' as const, message,
    choices: values.map((value, index) => ({
      value, label: sanitizeGlassHiveCallbackText(labels[index]), kind: kinds[index],
    })),
    ...(typeof option.description === 'string'
      ? { operationTitle: sanitizeGlassHiveCallbackText(option.description) } : {}),
  };
}

function projectWorkRows(rows: WorkItem[], observationMetadata = true) {
  return rows.map((item) => {
    const deliveryScope = normalizeWorkDeliveryScope(item.deliveryScope);
    return {
      workRef: item.workRef,
      title: text(item.title, 256),
      state: text(item.state, 40),
      ...(observationMetadata ? { updatedAt: text(item.updatedAt, 64) } : {}),
      actions: Array.isArray(item.actions)
        ? item.actions
            .filter((action) => typeof action === 'string')
        : [],
      ...(observationMetadata && item.delivery ? { deliveryState: text(item.delivery.state, 40) } : {}),
      ...(deliveryScope ? { deliveryScope } : {}),
      ...(item.attention ? { attention: {
        kind: text(item.attention.kind, 40),
        ...(typeof item.attention.code === 'string' ? { code: text(item.attention.code, 120) } : {}),
      } } : {}),
      ...(item.state === 'needs_input' && item.pendingNativeInput != null ? { nativeInputOmitted: true } : {}),
    } as {
      workRef: string; title: string; state: string; updatedAt?: string; actions: string[];
      deliveryState?: string; deliveryScope?: WorkDeliveryScope; nativeInputOmitted?: boolean;
      attention?: { kind: string; code?: string };
      pendingNativeInput?: NonNullable<ReturnType<typeof projectCurrentNativeWorkInput>>;
    };
  });
}

function appendCurrentNativeInputs(
  work: ReturnType<typeof projectWorkRows>,
  rows: WorkItem[],
  freshness: string | undefined,
  maxBytes: number,
  render: () => string,
) {
  work.forEach((item, index) => {
    const pendingNativeInput = projectCurrentNativeWorkInput(rows[index], freshness);
    if (!pendingNativeInput) return;
    item.pendingNativeInput = pendingNativeInput;
    delete item.nativeInputOmitted;
    if (Buffer.byteLength(render(), 'utf8') > maxBytes) {
      delete item.pendingNativeInput;
      item.nativeInputOmitted = true;
    }
  });
}

/** Compact tool facts retain every fetched identity; native pagination alone owns continuation. */
export function projectActiveWorkRoster(value: unknown, scope: 'active' | 'history') {
  const source = record(value);
  if (!Array.isArray(source.work)) return value;
  const rows = (source.work as WorkItem[]).filter(
    (item) => item && typeof item.workRef === 'string',
  );
  const sorted = [...rows].sort(
    (left, right) => Number(attention(right)) - Number(attention(left)) ||
      text(right.updatedAt, 64).localeCompare(text(left.updatedAt, 64)),
  );
  const work = projectWorkRows(sorted, false);
  const maxBytes = 19 * 1024;
  const projected = {
    snapshot: source.snapshot,
    scope,
    optionalMetadataOmitted: true,
    omittedVisibleWork: source.work.length - rows.length,
    exceedsCompactBudget: false,
    overflowCount: source.overflowCount ?? null,
    ...(typeof source.cursor === 'string' ? { cursor: source.cursor } : {}),
    work,
  };
  const render = () => JSON.stringify(projected);
  projected.exceedsCompactBudget = Buffer.byteLength(render(), 'utf8') > maxBytes;
  if (!projected.exceedsCompactBudget) {
    appendCurrentNativeInputs(work, sorted, typeof source.snapshot === 'string' ? source.snapshot : undefined,
      maxBytes, render);
  }
  if (!projected.exceedsCompactBudget) return projected;
  const { work: retainedWork, ...metadata } = projected;
  return { ...metadata, fullOutputRequired: true, nativeSavedOutputRequiredIfTruncated: true, work: retainedWork };
}

/** Render only current work facts; provider delivery owns placement outside durable authority. */
export function formatActiveWorkContext({
  snapshot,
  preferredMode,
  available,
  readiness,
}: {
  snapshot: WorkSnapshot;
  preferredMode: 'parallel' | 'focused';
  available: boolean;
  readiness?: { status?: string; reason?: string };
  voice?: boolean;
}): string {
  const rows = Array.isArray(snapshot.work)
    ? snapshot.work.filter((item) => item && typeof item.workRef === 'string')
    : null;
  const sorted = [...(rows || [])].sort(
    (left, right) =>
      Number(attention(right)) - Number(attention(left)) ||
      text(right.updatedAt, 64).localeCompare(text(left.updatedAt, 64)),
  );
  /* === VIVENTIUM START === Same known work facts for Voice without another roster lookup. === */
  const work = projectWorkRows(sorted);
  /* === VIVENTIUM END === */
  const facts = {
    preferredMode,
    available,
    ...(preferredMode === 'parallel' && available === false
      ? {
          readiness: {
            status: text(readiness?.status, 40) || 'unknown',
            reason: text(readiness?.reason, 120) || null,
          },
        }
      : {}),
    snapshot: text(snapshot.snapshot, 32) || 'unavailable',
    activeCount: rows ? rows.filter((item) => !TERMINAL_STATES.has(item.state || '')).length : null,
    work: rows ? work : null,
    overflowCount: snapshot.overflowCount ?? null,
    omittedVisibleWork: 0,
    fullRosterTool: 'active_work_list',
  };
  const mode = available ? preferredMode : 'focused';
  const render = () => `# Parallel work\nMode: ${mode}\n${JSON.stringify(facts)}`;
  while (work.length && Buffer.byteLength(render(), 'utf8') > MAX_CONTEXT_BYTES) {
    work.pop();
    facts.omittedVisibleWork += 1;
  }
  // Budget basic work truth first. Optional forms never displace another work row.
  appendCurrentNativeInputs(work, sorted, snapshot.snapshot, MAX_CONTEXT_BYTES, render);
  return render();
}

/** Pin an existing owner-scoped snapshot request while other Main preparation proceeds. */
export function createActiveWorkContextService(dependencies: ContextDependencies) {
  const ownerId = (req: ContextRequest) => String(req.user?.id || req.user?._id || '').trim();
  const scope = (req: ContextRequest) => `${dependencies.tenantId()}\0${ownerId(req)}`;

  function startActiveWorkContext(req: ContextRequest, agent: ContextAgent) {
    if (!req || !ownerId(req) || !isDeclaredConversationOrchestrator(agent)) {
      return Promise.resolve(null);
    }
    const currentScope = scope(req);
    const currentOwner = ownerId(req);
    if (req._viventiumActiveWorkContext?.scope === currentScope) {
      return req._viventiumActiveWorkContext.promise;
    }
    let promise: Promise<WorkSnapshot | null>;
    if (
      dependencies.preferredMode(req.user) === 'focused' &&
      req.user?.personalization?.parallel_work_known !== true
    ) {
      promise = Promise.resolve(null);
    } else {
      let timer: ReturnType<typeof setTimeout>;
      promise = Promise.race([
        Promise.resolve().then(() =>
          dependencies.getActiveWorkSnapshot({
            ownerId: currentOwner,
            timeoutMs: COLD_WAIT_MS,
          }),
        ),
        new Promise<WorkSnapshot>((resolve) => {
          timer = setTimeout(() => resolve(unavailable()), COLD_WAIT_MS);
          timer.unref?.();
        }),
      ])
        .catch(unavailable)
        .finally(() => clearTimeout(timer));
    }
    Object.defineProperty(req, '_viventiumActiveWorkContext', {
      configurable: true,
      writable: true,
      value: { scope: currentScope, promise },
    });
    return promise;
  }

  async function getActiveWorkTurnContext(
    req: ContextRequest,
    agent: ContextAgent,
    { voice = false }: { voice?: boolean } = {},
  ) {
    const expectedScope = scope(req);
    const snapshot = await startActiveWorkContext(req, agent);
    if (!snapshot) return '';
    return formatActiveWorkContext({
      snapshot: scope(req) === expectedScope ? snapshot : unavailable(),
      preferredMode: dependencies.preferredMode(req.user),
      available: req._viventiumParallelWorkTurnAvailable === true,
      readiness: req._viventiumParallelWorkTurnReadiness,
      voice,
    });
  }

  return { startActiveWorkContext, getActiveWorkTurnContext };
}
