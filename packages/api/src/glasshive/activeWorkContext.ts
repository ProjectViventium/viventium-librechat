import { isDeclaredConversationOrchestrator } from './conversationOrchestration';

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

/** Render only current work facts; provider delivery owns placement outside durable authority. */
export function formatActiveWorkContext({
  snapshot,
  preferredMode,
  available,
  voice = false,
}: {
  snapshot: WorkSnapshot;
  preferredMode: 'parallel' | 'focused';
  available: boolean;
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
  const selected = voice ? sorted.filter(attention) : sorted;
  const work = selected.map((item) => ({
    workRef: text(item.workRef, 160),
    title: text(item.title, 256),
    state: text(item.state, 40),
    updatedAt: text(item.updatedAt, 64),
    actions: Array.isArray(item.actions)
      ? item.actions
          .filter((action) => typeof action === 'string')
          .slice(0, 12)
          .map((action) => text(action, 32))
      : [],
    ...(item.delivery ? { deliveryState: text(item.delivery.state, 40) } : {}),
  }));
  const facts = {
    preferredMode,
    available,
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
      voice,
    });
  }

  return { startActiveWorkContext, getActiveWorkTurnContext };
}
