/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Share accessible setup fields and actions across Viventium channel forms.
 * === VIVENTIUM END ===
 */

import type { InputHTMLAttributes, ReactNode } from 'react';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export const fieldClassName = cn(
  'w-full rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary',
  'placeholder:text-text-secondary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
);

export function SetupField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block space-y-1 text-xs text-text-secondary">
      <span>{label}</span>
      <input className={fieldClassName} autoComplete="off" {...props} />
    </label>
  );
}

export function SetupActions({
  isSubmitting,
  onCancel,
}: {
  isSubmitting: boolean;
  onCancel: () => void;
}) {
  const localize = useLocalize();
  return (
    <div className="flex flex-wrap justify-end gap-2 pt-1">
      <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
        {localize('com_ui_connected_channels_cancel')}
      </Button>
      <Button type="submit" disabled={isSubmitting}>
        {localize('com_ui_connected_channels_save')}
      </Button>
    </div>
  );
}

export function SetupPanel({ children }: { children: ReactNode }) {
  return <div className="mt-3 space-y-3 border-t border-border-light pt-3">{children}</div>;
}
