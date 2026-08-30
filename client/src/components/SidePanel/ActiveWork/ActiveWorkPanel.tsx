/* === VIVENTIUM START ===
 * Feature: Authoritative Active work controls in the Control Panel.
 * Purpose: Keep durable missions visible and controllable beside the conversation that owns them.
 * === VIVENTIUM END === */

import { useMemo, useRef, useState } from 'react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import {
  type WorkAction,
  type WorkSummary,
  useActiveWorkHistoryQuery,
  useActiveWorkQuery,
  useWorkActionMutation,
} from '~/data-provider/ViventiumOrchestration';
import { useAuthContext, useLocalize } from '~/hooks';

const SUPPORTED_ACTIONS: WorkAction[] = [
  'queue',
  'message',
  'steer',
  'pause',
  'resume',
  'stop',
  'retry',
  'dismiss',
];

const INSTRUCTION_ACTIONS = new Set<WorkAction>(['queue', 'message', 'steer']);
const CONFIRM_ACTIONS = new Set<WorkAction>(['stop']);
const LEGACY_ACTION_OPERATION_STORAGE_KEY = 'viventium.parallel-work.action-operations.v1';
const ACTION_OPERATION_STORAGE_PREFIX = 'viventium.parallel-work.action-operations.v2.';
const ACTION_OPERATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HISTORY_PANEL_ID = 'active-work-history-panel';

const ACTION_LABELS = {
  queue: 'com_ui_parallel_work_action_queue',
  message: 'com_ui_parallel_work_action_message',
  steer: 'com_ui_parallel_work_action_steer',
  pause: 'com_ui_parallel_work_action_pause',
  resume: 'com_ui_parallel_work_action_resume',
  stop: 'com_ui_parallel_work_action_stop',
  retry: 'com_ui_parallel_work_action_retry',
  dismiss: 'com_ui_parallel_work_action_dismiss',
} as const;

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const ATTENTION_STATES = new Set(['paused', 'needs_input']);

function needsAttention(work: WorkSummary): boolean {
  return Boolean(
    work.attention ||
    ATTENTION_STATES.has(work.state) ||
    work.actions?.includes('retry') ||
    ['failed', 'unknown'].includes(work.delivery?.state) ||
    (!TERMINAL_STATES.has(work.state) && (work.nativeTeam?.needsAttention ?? 0) > 0),
  );
}

function safeViewRef(viewRef?: string): string | null {
  if (!viewRef) {
    return null;
  }
  try {
    const parsed = new URL(viewRef);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function createOperationId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

type StoredActionOperation = {
  operationId: string;
  createdAt: number;
  workRef: string;
  action: WorkAction;
  instruction: string;
};

function actionOperationKey(workRef: string, action: WorkAction, instruction = ''): string {
  return JSON.stringify([workRef, action, instruction]);
}

function actionOperationStorageKey(accountScope: string): string {
  return `${ACTION_OPERATION_STORAGE_PREFIX}${encodeURIComponent(accountScope)}`;
}

function readStoredActionOperations(accountScope: string): Record<string, StoredActionOperation> {
  if (typeof window === 'undefined' || !accountScope) {
    return {};
  }
  try {
    // Version 1 had no account boundary, so it cannot be migrated safely.
    window.localStorage.removeItem(LEGACY_ACTION_OPERATION_STORAGE_KEY);
    const value = JSON.parse(
      window.localStorage.getItem(actionOperationStorageKey(accountScope)) ?? '{}',
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const cutoff = Date.now() - ACTION_OPERATION_MAX_AGE_MS;
    return Object.fromEntries(
      Object.entries(value).filter(([, candidate]) => {
        const operation = candidate as Partial<StoredActionOperation>;
        return (
          typeof operation.operationId === 'string' &&
          typeof operation.createdAt === 'number' &&
          typeof operation.workRef === 'string' &&
          SUPPORTED_ACTIONS.includes(operation.action as WorkAction) &&
          typeof operation.instruction === 'string' &&
          operation.createdAt >= cutoff
        );
      }),
    ) as Record<string, StoredActionOperation>;
  } catch {
    return {};
  }
}

function writeStoredActionOperations(
  accountScope: string,
  operations: Record<string, StoredActionOperation>,
): void {
  if (typeof window === 'undefined' || !accountScope) {
    return;
  }
  try {
    window.localStorage.setItem(
      actionOperationStorageKey(accountScope),
      JSON.stringify(operations),
    );
  } catch {
    // Storage can be disabled; the mounted WorkItem retains the operation in memory.
  }
}

function findStoredActionOperation(
  accountScope: string,
  workRef: string,
  action: WorkAction,
): StoredActionOperation | undefined {
  return Object.values(readStoredActionOperations(accountScope)).find(
    (operation) => operation.workRef === workRef && operation.action === action,
  );
}

function reserveActionOperation(
  accountScope: string,
  workRef: string,
  action: WorkAction,
  instruction = '',
): StoredActionOperation {
  const operations = readStoredActionOperations(accountScope);
  const retained = Object.values(operations).find(
    (operation) => operation.workRef === workRef && operation.action === action,
  );
  if (retained) {
    return retained;
  }
  const key = actionOperationKey(workRef, action, instruction);
  const operation = {
    operationId: createOperationId(),
    createdAt: Date.now(),
    workRef,
    action,
    instruction,
  };
  operations[key] = operation;
  writeStoredActionOperations(accountScope, operations);
  return operation;
}

function clearActionOperation(
  accountScope: string,
  workRef: string,
  action: WorkAction,
  instruction = '',
): void {
  const operations = readStoredActionOperations(accountScope);
  const key = actionOperationKey(workRef, action, instruction);
  if (!(key in operations)) {
    return;
  }
  delete operations[key];
  writeStoredActionOperations(accountScope, operations);
}

type WorkActionError = {
  code?: unknown;
  response?: {
    status?: number;
    data?: {
      code?: unknown;
      error?: { code?: unknown };
    };
  };
};

function actionErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const typedError = error as WorkActionError;
  const code =
    typedError.response?.data?.error?.code ?? typedError.response?.data?.code ?? typedError.code;
  return typeof code === 'string' ? code : null;
}

function isDismissDeliveryNotSettledError(error: unknown): boolean {
  return (
    (error as WorkActionError)?.response?.status === 409 &&
    actionErrorCode(error) === 'glasshive_dismiss_delivery_not_settled'
  );
}

function isIndeterminateActionError(error: unknown): boolean {
  if (isDismissDeliveryNotSettledError(error)) {
    return false;
  }
  const status = (error as WorkActionError)?.response?.status;
  return (
    status == null ||
    status >= 500 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429
  );
}

function stateLabel(state: string): string {
  return state.replaceAll('_', ' ');
}

function sameText(first?: string | null, second?: string | null): boolean {
  return Boolean(
    first && second && first.trim().toLocaleLowerCase() === second.trim().toLocaleLowerCase(),
  );
}

function terminalDeliveryLabelKey(work: WorkSummary) {
  if (!TERMINAL_STATES.has(work.state) || !work.delivery?.state) {
    return null;
  }
  if (['delivered', 'acknowledged', 'silent'].includes(work.delivery.state)) {
    if (work.state === 'failed') return 'com_ui_parallel_work_failure_reported' as const;
    if (work.state === 'cancelled') return 'com_ui_parallel_work_cancellation_reported' as const;
    return 'com_ui_parallel_work_result_delivered' as const;
  }
  if (work.delivery.state === 'failed') {
    return 'com_ui_parallel_work_result_delivery_failed' as const;
  }
  if (work.delivery.state === 'unknown') {
    return 'com_ui_parallel_work_result_delivery_unknown' as const;
  }
  return 'com_ui_parallel_work_result_delivery_pending' as const;
}

function WorkItem({ work }: { work: WorkSummary }) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const accountScope = String(user?.id || '').trim();
  const { showToast } = useToastContext();
  const actionMutation = useWorkActionMutation();
  const [instruction, setInstruction] = useState(
    () =>
      SUPPORTED_ACTIONS.map((action) =>
        findStoredActionOperation(accountScope, work.workRef, action),
      ).find((operation) => operation?.instruction)?.instruction ?? '',
  );
  const [pendingAction, setPendingAction] = useState<WorkAction | null>(null);
  const [uncertainAction, setUncertainAction] = useState<WorkAction | null>(
    () =>
      SUPPORTED_ACTIONS.find((action) =>
        findStoredActionOperation(accountScope, work.workRef, action),
      ) ?? null,
  );
  const operations = useRef<Partial<Record<WorkAction, StoredActionOperation>>>({});
  const actions = useMemo(() => {
    const mask = Array.isArray(work.actions) ? work.actions : [];
    const visible = SUPPORTED_ACTIONS.filter((action) => mask.includes(action));
    // A response can be lost after GlassHive commits the action and advances
    // the work state. Keep that exact stored operation visible even when the
    // new state no longer advertises the original action; the backend then
    // replays the durable receipt instead of minting a second effect.
    if (uncertainAction && !visible.includes(uncertainAction)) {
      visible.push(uncertainAction);
    }
    return visible;
  }, [uncertainAction, work.actions]);
  const needsInstruction = actions.some((action) => INSTRUCTION_ACTIONS.has(action));
  const viewRef = safeViewRef(work.viewRef);
  const deliveryLabelKey = terminalDeliveryLabelKey(work);
  const deliveryLabel = deliveryLabelKey ? localize(deliveryLabelKey) : null;
  const attentionSummary = work.attention?.summary.trim();
  const statusSummary = work.statusSummary?.trim();
  const statusIsRedundant =
    sameText(statusSummary, stateLabel(work.state)) ||
    sameText(statusSummary, attentionSummary) ||
    sameText(statusSummary, deliveryLabel);
  const attentionIsRedundant = sameText(attentionSummary, stateLabel(work.state));
  const showDeliveryLabel = Boolean(deliveryLabel && !sameText(deliveryLabel, attentionSummary));
  const showUnreadDelivery = Boolean(deliveryLabel && work.delivery.unreadTerminal);
  const nativeTeam =
    !TERMINAL_STATES.has(work.state) &&
    work.nativeTeam &&
    (work.nativeTeam.total > 1 || work.nativeTeam.needsAttention > 0 || work.nativeTeam.degraded)
      ? work.nativeTeam
      : null;

  const runAction = (action: WorkAction) => {
    const cleanInstruction = instruction.trim();
    if (INSTRUCTION_ACTIONS.has(action) && !cleanInstruction) {
      return;
    }
    if (
      CONFIRM_ACTIONS.has(action) &&
      !window.confirm(
        localize('com_ui_parallel_work_action_confirm', {
          0: localize(ACTION_LABELS[action]),
          1: work.title,
        }),
      )
    ) {
      return;
    }

    setPendingAction(action);
    const operation =
      operations.current[action] ??
      reserveActionOperation(accountScope, work.workRef, action, cleanInstruction);
    operations.current[action] = operation;
    const canonicalInstruction = operation.instruction;
    if (INSTRUCTION_ACTIONS.has(action) && canonicalInstruction !== cleanInstruction) {
      setInstruction(canonicalInstruction);
    }
    actionMutation.mutate(
      {
        workRef: work.workRef,
        action,
        operationId: operation.operationId,
        ...(INSTRUCTION_ACTIONS.has(action) ? { instruction: canonicalInstruction } : {}),
      },
      {
        onSuccess: () => {
          clearActionOperation(accountScope, work.workRef, action, canonicalInstruction);
          delete operations.current[action];
          setUncertainAction(null);
          if (INSTRUCTION_ACTIONS.has(action)) {
            setInstruction('');
          }
          showToast({
            message: localize('com_ui_parallel_work_action_accepted'),
            status: 'success',
          });
        },
        onError: (error: unknown) => {
          const definitiveDismissalRejection =
            action === 'dismiss' && isDismissDeliveryNotSettledError(error);
          if (isIndeterminateActionError(error)) {
            setUncertainAction(action);
          } else {
            clearActionOperation(accountScope, work.workRef, action, canonicalInstruction);
            delete operations.current[action];
            setUncertainAction(null);
          }
          showToast({
            message: definitiveDismissalRejection
              ? localize(
                  terminalDeliveryLabelKey(work) ?? 'com_ui_parallel_work_result_delivery_pending',
                )
              : localize('com_ui_parallel_work_action_error'),
            status: 'error',
          });
        },
        onSettled: () => setPendingAction(null),
      },
    );
  };

  return (
    <li className="group py-4 first:pt-2 last:pb-2">
      <div className="min-w-0">
        <h4 className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
          {work.title}
        </h4>
        <p className="mt-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
          {[
            `${localize('com_ui_parallel_work_mission')}: ${stateLabel(work.state)}`,
            work.provider,
            work.originSurface,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {statusSummary && !statusIsRedundant && (
          <p className="mt-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
            {statusSummary}
          </p>
        )}
      </div>

      {attentionSummary && !attentionIsRedundant && (
        <p className="mt-2 text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
          {attentionSummary}
        </p>
      )}

      {(nativeTeam || showDeliveryLabel || showUnreadDelivery || viewRef) && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
          {nativeTeam && (
            <span>
              {localize('com_ui_parallel_work_native_team', {
                0: nativeTeam.active,
                1: nativeTeam.total,
                2: nativeTeam.needsAttention,
              })}
              {nativeTeam.degraded
                ? ` · ${localize('com_ui_parallel_work_native_team_degraded')}`
                : ''}
            </span>
          )}
          {(showDeliveryLabel || showUnreadDelivery) && (
            <span>
              {showDeliveryLabel ? deliveryLabel : null}
              {showUnreadDelivery
                ? `${showDeliveryLabel ? ' · ' : ''}${localize('com_ui_parallel_work_delivery_unread')}`
                : ''}
            </span>
          )}
          {viewRef && (
            <a
              href={viewRef}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={localize('com_ui_parallel_work_view_named', { 0: work.title })}
              className="inline-flex min-h-11 items-center rounded-sm px-1 font-medium text-text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-primary"
            >
              {localize('com_ui_parallel_work_view')}
            </a>
          )}
        </div>
      )}

      {needsInstruction && (
        <label className="mt-3 block text-sm text-text-secondary">
          {localize('com_ui_parallel_work_instruction')}
          <textarea
            rows={2}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            className="mt-1 w-full resize-y rounded-md border border-border-xheavy bg-surface-primary px-3 py-2 text-sm text-text-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={localize('com_ui_parallel_work_instruction')}
            placeholder={localize('com_ui_parallel_work_instruction_placeholder')}
          />
        </label>
      )}

      {actions.length > 0 && (
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label={localize('com_ui_parallel_work_actions')}
        >
          {actions.map((action) => {
            const label = localize(
              uncertainAction === action
                ? 'com_ui_parallel_work_action_retry_same'
                : ACTION_LABELS[action],
            );
            return (
              <Button
                key={action}
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                aria-label={label}
                aria-busy={pendingAction === action}
                disabled={
                  actionMutation.isLoading ||
                  pendingAction != null ||
                  (INSTRUCTION_ACTIONS.has(action) && !instruction.trim())
                }
                onClick={() => runAction(action)}
              >
                {pendingAction === action ? (
                  <>
                    <Spinner className="icon-sm" />
                    <span className="sr-only">{label}</span>
                  </>
                ) : (
                  label
                )}
              </Button>
            );
          })}
        </div>
      )}
      {uncertainAction && (
        <p className="mt-2 text-sm text-text-secondary" role="status">
          {localize('com_ui_parallel_work_action_uncertain')}
        </p>
      )}
    </li>
  );
}

export default function ActiveWorkPanel() {
  const localize = useLocalize();
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeWorkQuery = useActiveWorkQuery();
  const historyQuery = useActiveWorkHistoryQuery({ enabled: historyOpen });

  const knownSnapshot = ['fresh', 'stale', 'unavailable'].includes(
    activeWorkQuery.data?.snapshot ?? '',
  )
    ? activeWorkQuery.data?.snapshot
    : undefined;
  let snapshot = knownSnapshot;
  if (activeWorkQuery.isError) {
    snapshot = Array.isArray(activeWorkQuery.data?.work) ? 'stale' : 'unavailable';
  } else if (activeWorkQuery.data && !knownSnapshot) {
    snapshot = 'unavailable';
  }
  const work = activeWorkQuery.data?.work;
  const overflowCount = activeWorkQuery.data?.overflowCount ?? 0;
  const roster = useMemo(() => {
    const unique = new Map<string, WorkSummary>();
    for (const item of Array.isArray(work) ? work : []) {
      unique.set(item.workRef, item);
    }

    const attention: WorkSummary[] = [];
    const running: WorkSummary[] = [];
    const recent: WorkSummary[] = [];
    let activeCount = 0;

    for (const item of unique.values()) {
      const isTerminal = TERMINAL_STATES.has(item.state);
      if (!isTerminal) {
        activeCount += 1;
      }
      if (needsAttention(item)) {
        attention.push(item);
      } else if (isTerminal) {
        recent.push(item);
      } else {
        running.push(item);
      }
    }

    return {
      activeCount,
      workRefs: new Set(unique.keys()),
      sections: [
        {
          key: 'attention',
          label: 'com_ui_parallel_work_needs_attention' as const,
          items: attention,
        },
        { key: 'running', label: 'com_ui_parallel_work_running_queued' as const, items: running },
        { key: 'recent', label: 'com_ui_parallel_work_recent_results' as const, items: recent },
      ],
    };
  }, [work]);
  const historyEntries = historyQuery.data?.work;
  const historyWork = useMemo(() => {
    const seen = new Set(roster.workRefs);
    const items: WorkSummary[] = [];
    for (const item of Array.isArray(historyEntries) ? historyEntries : []) {
      if (!TERMINAL_STATES.has(item.state) || seen.has(item.workRef)) {
        continue;
      }
      seen.add(item.workRef);
      items.push(item);
    }
    return items;
  }, [historyEntries, roster.workRefs]);
  const historyUnavailable = historyQuery.isError || historyQuery.data?.snapshot === 'unavailable';

  return (
    <div className="px-1 pb-4 pt-1">
      {(snapshot === 'fresh' || snapshot === 'stale') && (
        <div className="flex justify-end px-1 pb-2">
          <span className="text-xs text-text-secondary">
            {localize(
              snapshot === 'fresh'
                ? 'com_ui_parallel_work_snapshot_fresh'
                : 'com_ui_parallel_work_snapshot_stale',
            )}
          </span>
        </div>
      )}

      {activeWorkQuery.isLoading && !activeWorkQuery.data && (
        <div
          className="flex items-center gap-2 px-1 py-3 text-sm text-text-secondary"
          role="status"
        >
          <Spinner className="icon-sm" />
          {localize('com_ui_parallel_work_loading')}
        </div>
      )}

      {snapshot === 'unavailable' && (
        <div className="mx-1 rounded-lg bg-surface-secondary p-3" role="status">
          <p className="text-sm text-text-primary">
            {localize('com_ui_parallel_work_unavailable')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 min-h-11"
            onClick={() => void activeWorkQuery.refetch()}
          >
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}

      {snapshot !== 'unavailable' &&
        Array.isArray(work) &&
        roster.activeCount === 0 &&
        overflowCount === 0 && (
          <p className="px-1 py-3 text-sm text-text-secondary" role="status">
            {localize('com_ui_parallel_work_empty')}
          </p>
        )}

      {Array.isArray(work) && work.length > 0 && (
        <div className="space-y-4 px-1">
          {roster.sections
            .filter((section) => section.items.length > 0)
            .map((section) => (
              <section key={section.key} aria-labelledby={`active-work-${section.key}`}>
                <h3
                  id={`active-work-${section.key}`}
                  className="border-b border-border-light pb-2 text-sm font-medium text-text-primary"
                >
                  {localize(section.label)}
                </h3>
                <ul className="divide-y divide-border-light">
                  {section.items.map((item) => (
                    <WorkItem key={item.workRef} work={item} />
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}

      {overflowCount > 0 && snapshot !== 'unavailable' && (
        <div className="mt-2 flex items-center gap-2 border-t border-border-light px-1 pt-3">
          <p className="text-sm text-text-secondary" role="status">
            {localize('com_ui_parallel_work_overflow', { 0: overflowCount })}
          </p>
          {activeWorkQuery.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              aria-label={localize('com_ui_parallel_work_load_more')}
              aria-busy={activeWorkQuery.isFetchingNextPage}
              disabled={activeWorkQuery.isFetchingNextPage}
              onClick={() => void activeWorkQuery.fetchNextPage()}
            >
              {activeWorkQuery.isFetchingNextPage ? (
                <Spinner className="icon-sm" />
              ) : (
                localize('com_ui_parallel_work_load_more')
              )}
            </Button>
          )}
          {!activeWorkQuery.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => void activeWorkQuery.refetch()}
            >
              {localize('com_ui_refresh')}
            </Button>
          )}
        </div>
      )}

      <section className="mt-4 border-t border-border-light px-1 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 w-full justify-between"
          aria-expanded={historyOpen}
          aria-controls={historyOpen ? HISTORY_PANEL_ID : undefined}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {localize('com_ui_parallel_work_history')}
        </Button>
        {historyOpen && (
          <div id={HISTORY_PANEL_ID} className="pt-2">
            {historyQuery.isLoading && !historyQuery.data && (
              <div
                className="flex items-center gap-2 py-3 text-sm text-text-secondary"
                role="status"
              >
                <Spinner className="icon-sm" />
                {localize('com_ui_parallel_work_loading')}
              </div>
            )}
            {historyUnavailable && (
              <div className="rounded-lg bg-surface-secondary p-3" role="status">
                <p className="text-sm text-text-primary">
                  {localize('com_ui_parallel_work_history_unavailable')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 min-h-11"
                  onClick={() => void historyQuery.refetch()}
                >
                  {localize('com_ui_retry')}
                </Button>
              </div>
            )}
            {!historyUnavailable && Array.isArray(historyEntries) && (
              <>
                {historyWork.length === 0 && !historyQuery.hasNextPage && (
                  <p className="py-3 text-sm text-text-secondary" role="status">
                    {localize('com_ui_parallel_work_history_empty')}
                  </p>
                )}
                {historyWork.length > 0 && (
                  <ul className="divide-y divide-border-light">
                    {historyWork.map((item) => (
                      <WorkItem key={item.workRef} work={item} />
                    ))}
                  </ul>
                )}
                {historyQuery.hasNextPage && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 min-h-11"
                    aria-label={localize('com_ui_parallel_work_load_more')}
                    aria-busy={historyQuery.isFetchingNextPage}
                    disabled={historyQuery.isFetchingNextPage}
                    onClick={() => void historyQuery.fetchNextPage()}
                  >
                    {historyQuery.isFetchingNextPage ? (
                      <Spinner className="icon-sm" />
                    ) : (
                      localize('com_ui_parallel_work_load_more')
                    )}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
