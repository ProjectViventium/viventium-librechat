/* === VIVENTIUM START ===
 * Purpose: Render GlassHive harness progress summaries without exposing hidden chain-of-thought.
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

import { Activity, ChevronDown, Loader2 } from 'lucide-react';
import { useLocalize } from '~/hooks';

export default function HarnessActivity({
  summary,
  isSubmitting,
}: {
  summary: string;
  isSubmitting: boolean;
}) {
  const localize = useLocalize();
  const rows = summary
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length === 0) {
    return null;
  }

  return (
    <details className="bg-surface-secondary/50 group my-2 rounded-lg border border-border-light px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-text-secondary">
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Activity className="size-4" aria-hidden="true" />
        )}
        <span className="font-medium">{localize('com_ui_harness_activity')}</span>
        <ChevronDown
          className="ml-auto size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <ol className="mt-2 space-y-1 border-l border-border-medium pl-3 text-sm text-text-secondary">
        {rows.map((row, index) => (
          <li key={`${index}-${row}`}>{row}</li>
        ))}
      </ol>
    </details>
  );
}
