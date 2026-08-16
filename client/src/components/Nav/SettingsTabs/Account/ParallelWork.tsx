/* === VIVENTIUM START ===
 * Feature: Account-wide Parallel work and authoritative Active work controls.
 * Purpose: Keep Main available while durable missions remain visible and explicitly controllable.
 * === VIVENTIUM END === */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner, Switch, useToastContext } from '@librechat/client';
import {
  type WorkAction,
  type WorkSummary,
  useActiveWorkQuery,
  useOrchestrationPreferenceQuery,
  useUpdateOrchestrationMutation,
  useWorkActionMutation,
} from '~/data-provider/ViventiumOrchestration';
import { useAuthContext, useLocalize } from '~/hooks';

type ParallelWorkProps = {
  featureAvailable: boolean;
};

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

function isIndeterminateActionError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
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
          if (isIndeterminateActionError(error)) {
            setUncertainAction(action);
          } else {
            clearActionOperation(accountScope, work.workRef, action, canonicalInstruction);
            delete operations.current[action];
            setUncertainAction(null);
          }
          showToast({
            message: localize('com_ui_parallel_work_action_error'),
            status: 'error',
          });
        },
        onSettled: () => setPendingAction(null),
      },
    );
  };

  return (
    <li className="rounded-lg border border-border-light bg-surface-secondary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-sm font-medium text-text-primary">{work.title}</h4>
          {work.statusSummary && (
            <p className="mt-1 break-words text-xs text-text-secondary">{work.statusSummary}</p>
          )}
          {(work.provider || work.originSurface) && (
            <p className="mt-1 text-xs text-text-secondary">
              {[work.provider, work.originSurface].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <span className="rounded-full border border-border-light bg-surface-primary px-2 py-1 text-xs capitalize text-text-secondary">
          {stateLabel(work.state)}
        </span>
      </div>

      {work.attention?.summary && (
        <p className="mt-2 rounded-md border border-border-medium bg-surface-primary p-2 text-xs text-text-primary">
          {work.attention.summary}
        </p>
      )}

      {(work.nativeTeam || work.delivery?.state || viewRef) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
          {work.nativeTeam && (
            <span>
              {localize('com_ui_parallel_work_native_team', {
                0: work.nativeTeam.active,
                1: work.nativeTeam.total,
                2: work.nativeTeam.needsAttention,
              })}
              {work.nativeTeam.degraded
                ? ` · ${localize('com_ui_parallel_work_native_team_degraded')}`
                : ''}
            </span>
          )}
          {work.delivery?.state && (
            <span>
              {localize('com_ui_parallel_work_delivery', { 0: work.delivery.state })}
              {work.delivery.unreadTerminal
                ? ` · ${localize('com_ui_parallel_work_delivery_unread')}`
                : ''}
            </span>
          )}
          {viewRef && (
            <a
              href={viewRef}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-text-primary underline underline-offset-2"
            >
              {localize('com_ui_parallel_work_view')}
            </a>
          )}
        </div>
      )}

      {needsInstruction && (
        <label className="mt-3 block text-xs text-text-secondary">
          {localize('com_ui_parallel_work_instruction')}
          <textarea
            rows={2}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            className="mt-1 w-full resize-y rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary"
            aria-label={localize('com_ui_parallel_work_instruction')}
            placeholder={localize('com_ui_parallel_work_instruction_placeholder')}
          />
        </label>
      )}

      {actions.length > 0 && (
        <div
          className="mt-3 flex flex-wrap gap-2"
          aria-label={localize('com_ui_parallel_work_actions')}
        >
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant="outline"
              size="sm"
              disabled={
                actionMutation.isLoading ||
                pendingAction != null ||
                (INSTRUCTION_ACTIONS.has(action) && !instruction.trim())
              }
              onClick={() => runAction(action)}
            >
              {pendingAction === action ? (
                <Spinner className="icon-sm" />
              ) : (
                localize(
                  uncertainAction === action
                    ? 'com_ui_parallel_work_action_retry_same'
                    : ACTION_LABELS[action],
                )
              )}
            </Button>
          ))}
        </div>
      )}
      {uncertainAction && (
        <p className="mt-2 text-xs text-text-secondary" role="status">
          {localize('com_ui_parallel_work_action_uncertain')}
        </p>
      )}
    </li>
  );
}

function AvailableParallelWork({ featureAvailable }: ParallelWorkProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const preferenceQuery = useOrchestrationPreferenceQuery();
  const activeWorkQuery = useActiveWorkQuery();
  const updatePreference = useUpdateOrchestrationMutation();
  const [mode, setMode] = useState<'focused' | 'parallel'>('focused');

  useEffect(() => {
    if (preferenceQuery.data?.mode) {
      setMode(preferenceQuery.data.mode);
    }
  }, [preferenceQuery.data?.mode]);

  const setParallel = (checked: boolean) => {
    const previous = mode;
    const next = checked ? 'parallel' : 'focused';
    setMode(next);
    updatePreference.mutate(
      { mode: next },
      {
        onSuccess: () =>
          showToast({
            message: localize('com_ui_preferences_updated'),
            status: 'success',
          }),
        onError: () => {
          setMode(previous);
          showToast({
            message: localize('com_ui_error_updating_preferences'),
            status: 'error',
          });
        },
      },
    );
  };

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
  const preferenceAvailable = preferenceQuery.data?.available === true;
  const overflowCount = activeWorkQuery.data?.overflowCount ?? 0;

  // A runtime rollback disables new automatic launches, but must not erase already-running work.
  // Hide only a provably fresh empty board when the product switch is unavailable.
  if (!featureAvailable && snapshot === 'fresh' && Array.isArray(work) && work.length === 0) {
    return null;
  }

  return (
    <section
      className="rounded-xl border border-border-light bg-surface-primary p-4"
      aria-label={localize('com_ui_parallel_work')}
    >
      {featureAvailable && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              {localize('com_ui_parallel_work')}
            </h3>
            <p id="parallel-work-description" className="mt-1 text-xs text-text-secondary">
              {localize('com_ui_parallel_work_description')}
            </p>
          </div>
          {preferenceQuery.isLoading ? (
            <Spinner className="icon-sm" />
          ) : (
            <Switch
              checked={mode === 'parallel'}
              onCheckedChange={setParallel}
              disabled={
                !preferenceAvailable || preferenceQuery.isError || updatePreference.isLoading
              }
              aria-label={localize('com_ui_parallel_work')}
              aria-describedby="parallel-work-description"
            />
          )}
        </div>
      )}

      {featureAvailable &&
        (preferenceQuery.isError ||
          (!preferenceQuery.isLoading && preferenceQuery.data?.available === false)) && (
          <p className="mt-2 text-xs text-text-secondary" role="status">
            {localize('com_ui_parallel_work_toggle_unavailable')}
          </p>
        )}

      <div className={featureAvailable ? 'mt-4 border-t border-border-light pt-4' : ''}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {localize('com_ui_parallel_work_active')}
          </h3>
          {(snapshot === 'fresh' || snapshot === 'stale') && (
            <span className="text-xs text-text-secondary" role="status">
              {localize(
                snapshot === 'fresh'
                  ? 'com_ui_parallel_work_snapshot_fresh'
                  : 'com_ui_parallel_work_snapshot_stale',
              )}
            </span>
          )}
        </div>

        {activeWorkQuery.isLoading && !activeWorkQuery.data && (
          <div className="mt-3 flex items-center gap-2 text-xs text-text-secondary" role="status">
            <Spinner className="icon-sm" />
            {localize('com_ui_parallel_work_loading')}
          </div>
        )}

        {snapshot === 'unavailable' && (
          <div className="mt-3 rounded-lg bg-surface-secondary p-3" role="status">
            <p className="text-xs text-text-secondary">
              {localize('com_ui_parallel_work_unavailable')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void activeWorkQuery.refetch()}
            >
              {localize('com_ui_retry')}
            </Button>
          </div>
        )}

        {snapshot !== 'unavailable' && Array.isArray(work) && work.length === 0 && (
          <p className="mt-3 text-xs text-text-secondary" role="status">
            {localize('com_ui_parallel_work_empty')}
          </p>
        )}

        {Array.isArray(work) && work.length > 0 && (
          <ul className="mt-3 space-y-2">
            {work.map((item) => (
              <WorkItem key={item.workRef} work={item} />
            ))}
          </ul>
        )}

        {overflowCount > 0 && snapshot !== 'unavailable' && (
          <div className="mt-3 flex items-center gap-2">
            <p className="text-xs text-text-secondary" role="status">
              {localize('com_ui_parallel_work_overflow', { 0: overflowCount })}
            </p>
            {activeWorkQuery.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
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
          </div>
        )}
      </div>
    </section>
  );
}

export default function ParallelWork({ featureAvailable }: ParallelWorkProps) {
  return <AvailableParallelWork featureAvailable={featureAvailable} />;
}
