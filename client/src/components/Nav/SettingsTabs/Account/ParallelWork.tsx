/* === VIVENTIUM START ===
 * Feature: Account-wide Parallel work preference.
 * Purpose: Keep configuration in Account while live work stays in the Control Panel.
 * === VIVENTIUM END === */

import { useEffect, useState } from 'react';
import { Spinner, Switch, useToastContext } from '@librechat/client';
import {
  useOrchestrationPreferenceQuery,
  useUpdateOrchestrationMutation,
} from '~/data-provider/ViventiumOrchestration';
import { useLocalize } from '~/hooks';

export default function ParallelWork() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const preferenceQuery = useOrchestrationPreferenceQuery();
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

  const preferenceAvailable = preferenceQuery.data?.available === true;
  const readinessPending =
    !preferenceQuery.isError && preferenceQuery.data?.releaseGate?.blockers.includes('stale');
  const installationDisabled =
    !preferenceQuery.isError && preferenceQuery.data?.releaseGate?.blockers.includes('disabled');
  const unavailableMessage = installationDisabled
    ? 'com_ui_parallel_work_installation_disabled'
    : 'com_ui_parallel_work_toggle_unavailable';

  return (
    <section
      className="rounded-xl border border-border-light bg-surface-primary p-4"
      aria-label={localize('com_ui_parallel_work')}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            {localize('com_ui_parallel_work')}
          </h3>
          <p id="parallel-work-description" className="mt-1 text-xs text-text-secondary">
            {localize('com_ui_parallel_work_description')}
            {mode === 'parallel' && (
              <span className="mt-1 block">{localize('com_ui_parallel_work_existing_work')}</span>
            )}
          </p>
        </div>
        {preferenceQuery.isLoading ? (
          <Spinner className="icon-sm" />
        ) : (
          <Switch
            checked={mode === 'parallel'}
            onCheckedChange={setParallel}
            disabled={
              updatePreference.isLoading ||
              (mode !== 'parallel' && (!preferenceAvailable || preferenceQuery.isError))
            }
            aria-label={localize('com_ui_parallel_work')}
            aria-describedby="parallel-work-description"
          />
        )}
      </div>

      {(preferenceQuery.isError ||
        (!preferenceQuery.isLoading && preferenceQuery.data?.available === false)) && (
        <p className="mt-2 text-xs text-text-secondary" role="status">
          {localize(readinessPending ? 'com_ui_glasshive_checking' : unavailableMessage)}
        </p>
      )}
      {!readinessPending && preferenceQuery.data?.releaseGate && (
        <details className="mt-2 text-xs text-text-secondary">
          <summary className="cursor-pointer">{localize('com_ui_additional_details')}</summary>
          <p className="font-semibold">{preferenceQuery.data.releaseGate.label}</p>
          {preferenceQuery.data.releaseGate.blockers.length > 0 && (
            <p>{preferenceQuery.data.releaseGate.blockers.join(', ')}</p>
          )}
        </details>
      )}
    </section>
  );
}
