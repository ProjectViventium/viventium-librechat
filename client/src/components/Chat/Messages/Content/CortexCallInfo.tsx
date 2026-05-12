/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Component: CortexCallInfo - Expandable details for cortex events
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * Added: 2026-01-03
 * === VIVENTIUM END === */
import { AlertCircle, Brain, Sparkles, Target } from 'lucide-react';
import type { CortexStatus } from 'librechat-data-provider';
import { cn } from '~/utils';

const PUBLIC_BACKGROUND_AGENT_ERROR =
  'This background agent hit a runtime issue before it could return a result.';
const PRIVATE_ERROR_PATTERN =
  /(?:\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\|Bearer\s+|api[_-]?key|token|@[a-z0-9.-]+\.[a-z]{2,})/i;
const ERROR_CLASS_LABELS: Record<string, string> = {
  activation_provider_unavailable: 'Activation provider unavailable',
  background_agent_error: 'Runtime issue',
  cortex_agent_not_found: 'Agent unavailable',
  no_live_tool_execution: 'No verified live-tool evidence',
  provider_access_denied: 'Provider access denied',
  provider_quota_or_billing: 'Provider quota or billing issue',
  provider_rate_limited: 'Provider rate limit',
  provider_unauthorized: 'Provider authentication issue',
  recoverable_provider_error: 'Recoverable provider issue',
  timeout: 'Timed out',
};

function publicErrorText(error?: string): string {
  const text = String(error || '').trim();
  if (!text) {
    return '';
  }
  if (PRIVATE_ERROR_PATTERN.test(text)) {
    return PUBLIC_BACKGROUND_AGENT_ERROR;
  }
  if (text.length > 220) {
    return PUBLIC_BACKGROUND_AGENT_ERROR;
  }
  return text;
}

function publicErrorClassLabel(errorClass?: string): string {
  const normalized = String(errorClass || '').trim().toLowerCase();
  if (!/^[a-z0-9_:-]{1,80}$/.test(normalized)) {
    return '';
  }
  return ERROR_CLASS_LABELS[normalized] || normalized.replaceAll('_', ' ');
}

export default function CortexCallInfo({
  cortex_name,
  status,
  confidence,
  reason,
  insight,
  error,
  error_class,
}: {
  cortex_name: string;
  status: CortexStatus;
  confidence?: number;
  reason?: string;
  insight?: string;
  error?: string;
  error_class?: string;
}) {
  const isSkipped = status === 'skipped';
  const safeError = publicErrorText(error);
  const safeErrorClass = publicErrorClassLabel(error_class);
  const hasError = status === 'error' && safeError.length > 0;

  return (
    <div className="flex flex-col divide-y divide-border-light">
      {/* Activation reason section */}
      {reason && (
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
            <Target className="size-3" />
            <span>Why this ran</span>
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

      {/* Error section */}
      {hasError && (
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-red-500">
            <AlertCircle className="size-3" />
            <span>Error from {cortex_name}</span>
          </div>
          <div className="whitespace-pre-wrap text-sm text-red-700 dark:text-red-300">
            {safeError}
          </div>
          {safeErrorClass && (
            <div className="text-xs text-red-600/80 dark:text-red-300/80">
              Issue type: {safeErrorClass}
            </div>
          )}
        </div>
      )}

      {/* Insight section */}
      {insight && (
        <div className="flex flex-col gap-1 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
            <Sparkles className="size-3 text-purple-500" />
            <span>Result from {cortex_name}</span>
          </div>
          <div className="text-sm text-text-primary whitespace-pre-wrap">
            {insight}
          </div>
        </div>
      )}

      {/* Status footer */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary bg-surface-tertiary/50">
        <Brain className="size-3" />
        <span>Background agent: {cortex_name}</span>
        <span className="ml-auto">
          {status === 'complete' && 'Analysis complete'}
          {status === 'brewing' && 'Analyzing...'}
          {status === 'activating' && 'Checking...'}
          {status === 'skipped' && 'Did not activate'}
          {status === 'error' && 'Error occurred'}
        </span>
      </div>
    </div>
  );
}
