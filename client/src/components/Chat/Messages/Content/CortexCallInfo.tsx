/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Component: CortexCallInfo - Expandable details for cortex events
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * Added: 2026-01-03
 * === VIVENTIUM END === */
import { Brain, Sparkles, Target } from 'lucide-react';
import type { CortexStatus } from 'librechat-data-provider';
import { cn } from '~/utils';

export default function CortexCallInfo({
  cortex_name,
  status,
  confidence,
  reason,
  insight,
}: {
  cortex_name: string;
  status: CortexStatus;
  confidence?: number;
  reason?: string;
  insight?: string;
}) {
  const isSkipped = status === 'skipped';

  return (
    <div className="flex flex-col divide-y divide-border-light">
      {/* Activation reason section */}
      {reason && (
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
            <Target className="size-3" />
            <span>Activation Reason</span>
            {confidence !== undefined && (
              <span className="ml-auto text-xs opacity-70">
                {Math.round(confidence * 100)}% confidence
              </span>
            )}
          </div>
          <div className={cn('text-sm text-text-primary', isSkipped && 'opacity-50')}>
            {reason}
          </div>
        </div>
      )}

      {/* Insight section */}
      {insight && (
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
            <Sparkles className="size-3 text-purple-500" />
            <span>Background Insight</span>
          </div>
          <div className="text-sm text-text-primary whitespace-pre-wrap">
            {insight}
          </div>
        </div>
      )}

      {/* Status footer */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary bg-surface-tertiary/50">
        <Brain className="size-3" />
        <span>{cortex_name}</span>
        <span className="ml-auto">
          {status === 'complete' && '✓ Analysis complete'}
          {status === 'brewing' && '⏳ Analyzing...'}
          {status === 'activating' && '🔍 Checking activation...'}
          {status === 'skipped' && '○ Did not activate'}
          {status === 'error' && '✕ Error occurred'}
        </span>
      </div>
    </div>
  );
}
