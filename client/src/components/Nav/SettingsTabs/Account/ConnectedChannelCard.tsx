/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Render one accessible channel lifecycle card without exposing credential values.
 * === VIVENTIUM END ===
 */

import type {
  ConnectedChannelConnectRequest,
  ConnectedChannelState,
  ConnectedChannelSummary,
} from 'librechat-data-provider';
import { Button } from '@librechat/client';
import ChannelSetup from './ConnectedChannels/ChannelSetup';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks';
import { cn } from '~/utils';

const PROVIDER_KEYS: Record<ConnectedChannelSummary['channel'], TranslationKeys> = {
  telegram: 'com_ui_connected_channels_telegram',
  slack: 'com_ui_connected_channels_slack',
  whatsapp: 'com_ui_connected_channels_whatsapp',
};

const DESCRIPTION_KEYS: Record<ConnectedChannelSummary['channel'], TranslationKeys> = {
  telegram: 'com_ui_connected_channels_telegram_description',
  slack: 'com_ui_connected_channels_slack_description',
  whatsapp: 'com_ui_connected_channels_whatsapp_description',
};

const STATE_KEYS: Record<ConnectedChannelState, TranslationKeys> = {
  not_configured: 'com_ui_connected_channels_not_configured',
  needs_vendor_step: 'com_ui_connected_channels_needs_vendor_step',
  verifying: 'com_ui_connected_channels_verifying',
  connected: 'com_ui_connected_channels_connected',
  degraded: 'com_ui_connected_channels_degraded',
  reauth_required: 'com_ui_connected_channels_reauth_required',
  disconnected: 'com_ui_connected_channels_disconnected',
};

const ISSUE_KEYS: Partial<Record<string, TranslationKeys>> = {
  invalid_credentials: 'com_ui_connected_channels_issue_invalid_credentials',
  missing_permission: 'com_ui_connected_channels_issue_missing_permission',
  approval_required: 'com_ui_connected_channels_issue_approval_required',
  public_https_required: 'com_ui_connected_channels_issue_public_https_required',
  connection_unavailable: 'com_ui_connected_channels_issue_connection_unavailable',
  connection_conflict: 'com_ui_connected_channels_issue_connection_conflict',
  connection_test_failed: 'com_ui_connected_channels_issue_connection_test_failed',
  credentials_unavailable: 'com_ui_connected_channels_issue_credentials_unavailable',
  operator_managed: 'com_ui_connected_channels_issue_operator_managed',
  webhook_verification_failed: 'com_ui_connected_channels_issue_webhook_verification_failed',
  webhook_verification_required: 'com_ui_connected_channels_issue_webhook_verification_required',
  signed_callback_pending: 'com_ui_connected_channels_issue_signed_callback_pending',
  replacement_webhook_verification_required:
    'com_ui_connected_channels_issue_replacement_webhook_verification_required',
  replacement_signed_callback_pending:
    'com_ui_connected_channels_issue_replacement_signed_callback_pending',
  webhook_in_use: 'com_ui_connected_channels_issue_webhook_in_use',
  transport_unavailable: 'com_ui_connected_channels_issue_transport_unavailable',
  worker_start_failed: 'com_ui_connected_channels_issue_worker_start_failed',
  worker_stop_failed: 'com_ui_connected_channels_issue_worker_stop_failed',
  rate_limited: 'com_ui_connected_channels_issue_rate_limited',
  delivery_uncertain: 'com_ui_connected_channels_issue_delivery_uncertain',
};

function statusClassName(state: ConnectedChannelState): string {
  if (state === 'connected') {
    return 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/30 dark:text-green-200';
  }
  if (state === 'degraded' || state === 'reauth_required' || state === 'needs_vendor_step') {
    return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200';
  }
  if (state === 'verifying') {
    return 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-200';
  }
  return 'border-border-light bg-surface-secondary text-text-secondary';
}

export default function ConnectedChannelCard({
  summary,
  isBusy,
  isConfirmingDisconnect,
  isSetupOpen,
  onCancelDisconnect,
  onCancelSetup,
  onConfirmDisconnect,
  onOpenSetup,
  onRequestDisconnect,
  onSave,
  onTest,
}: {
  summary: ConnectedChannelSummary;
  isBusy: boolean;
  isConfirmingDisconnect: boolean;
  isSetupOpen: boolean;
  onCancelDisconnect: () => void;
  onCancelSetup: () => void;
  onConfirmDisconnect: () => void;
  onOpenSetup: () => void;
  onRequestDisconnect: () => void;
  onSave: (input: ConnectedChannelConnectRequest) => void;
  onTest: () => void;
}) {
  const localize = useLocalize();
  const providerLabel = localize(PROVIDER_KEYS[summary.channel]);
  const hasConfiguration = !['not_configured', 'disconnected'].includes(summary.state);
  const issueKey = summary.issueCode ? ISSUE_KEYS[summary.issueCode] : undefined;

  return (
    <section
      className="rounded-xl border border-border-light bg-surface-primary p-3"
      aria-label={localize('com_ui_connected_channels_region', { provider: providerLabel })}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="font-medium text-text-primary">{providerLabel}</h3>
          <p className="text-xs text-text-secondary">
            {localize(DESCRIPTION_KEYS[summary.channel])}
          </p>
          {summary.displayName && (
            <p className="truncate text-xs text-text-secondary">{summary.displayName}</p>
          )}
        </div>
        <span
          className={cn(
            'w-fit shrink-0 rounded-full border px-2 py-1 text-xs font-medium',
            statusClassName(summary.state),
          )}
        >
          {localize(STATE_KEYS[summary.state])}
        </span>
      </div>

      {issueKey && (
        <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {localize(issueKey)}
        </p>
      )}
      {summary.issueCode && !issueKey && (
        <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {localize('com_ui_connected_channels_issue_unknown')}
        </p>
      )}
      {summary.channel === 'whatsapp' && summary.callbackUrl && (
        <label className="mt-3 block space-y-1 text-xs text-text-secondary">
          <span>{localize('com_ui_connected_channels_whatsapp_callback_url')}</span>
          <input
            readOnly
            type="url"
            value={summary.callbackUrl}
            className="w-full rounded-md border border-border-light bg-surface-secondary px-3 py-2 text-xs text-text-primary"
          />
        </label>
      )}

      {!isSetupOpen && !isConfirmingDisconnect && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {hasConfiguration && (
              <Button type="button" variant="outline" onClick={onTest} disabled={isBusy}>
                {localize('com_ui_connected_channels_test')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onOpenSetup} disabled={isBusy}>
              {localize(
                hasConfiguration
                  ? 'com_ui_connected_channels_repair'
                  : 'com_ui_connected_channels_set_up',
              )}
            </Button>
            {hasConfiguration && (
              <Button
                type="button"
                variant="outline"
                onClick={onRequestDisconnect}
                disabled={isBusy}
              >
                {localize('com_ui_connected_channels_disconnect')}
              </Button>
            )}
          </div>
        </>
      )}

      {isConfirmingDisconnect && (
        <div className="mt-3 rounded-lg border border-border-light bg-surface-secondary p-3">
          <p className="text-xs text-text-primary">
            {localize('com_ui_connected_channels_confirm_disconnect')}
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancelDisconnect} disabled={isBusy}>
              {localize('com_ui_connected_channels_cancel')}
            </Button>
            <Button type="button" onClick={onConfirmDisconnect} disabled={isBusy}>
              {localize('com_ui_connected_channels_disconnect')}
            </Button>
          </div>
        </div>
      )}

      {isSetupOpen && (
        <ChannelSetup
          channel={summary.channel}
          isSubmitting={isBusy}
          onCancel={onCancelSetup}
          onSubmit={onSave}
        />
      )}
    </section>
  );
}
