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

type ParallelWorkProps = {
  featureAvailable: boolean;
};

function ParallelWorkPreference() {
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
          </p>
        </div>
        {preferenceQuery.isLoading ? (
          <Spinner className="icon-sm" />
        ) : (
          <Switch
            checked={mode === 'parallel'}
            onCheckedChange={setParallel}
            disabled={!preferenceAvailable || preferenceQuery.isError || updatePreference.isLoading}
            aria-label={localize('com_ui_parallel_work')}
            aria-describedby="parallel-work-description"
          />
        )}
      </div>

      {(preferenceQuery.isError ||
        (!preferenceQuery.isLoading && preferenceQuery.data?.available === false)) && (
        <p className="mt-2 text-xs text-text-secondary" role="status">
          {localize('com_ui_parallel_work_toggle_unavailable')}
        </p>
      )}
      {preferenceQuery.data?.releaseGate && (
        <div className="mt-2 text-xs text-text-secondary" role="status">
          <p className="font-semibold">{preferenceQuery.data.releaseGate.label}</p>
          {preferenceQuery.data.releaseGate.blockers.length > 0 && (
            <p>{preferenceQuery.data.releaseGate.blockers.join(', ')}</p>
          )}
        </div>
      )}
    </section>
  );
}

export default function ParallelWork({ featureAvailable }: ParallelWorkProps) {
  return featureAvailable ? <ParallelWorkPreference /> : null;
}
