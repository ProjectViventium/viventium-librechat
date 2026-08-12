/* === VIVENTIUM START ===
 * Feature: WHOOP owner health onboarding.
 * Purpose: Give the local owner one visible connect flow, readable source coverage, automatic
 * history/correction status, and an official-export fallback without exposing private locators.
 * === VIVENTIUM END === */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { apiBaseUrl, request } from 'librechat-data-provider';
import { Button, Spinner, useToastContext } from '@librechat/client';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

type CoverageRow = { scope?: string | null; status?: string | null; items?: number | null };
type WhoopRun = {
  status?: string | null;
  finishedAt?: string | null;
  itemCount?: number | null;
};
type WhoopStatus = {
  state:
    | 'setup_required'
    | 'ready_to_authorize'
    | 'authorization_pending'
    | 'authorizing'
    | 'importing'
    | 'connected_no_data'
    | 'connected'
    | 'degraded';
  clientConfigured: boolean;
  authorized: boolean;
  authorizationRecoveryRequired: boolean;
  coverage: {
    api: Record<string, CoverageRow>;
    export: Record<string, { status?: string | null }>;
  };
  latestApiRun?: WhoopRun | null;
  latestExportRun?: WhoopRun | null;
  manualEvidence: { itemCount: number; latestAt?: string | null };
  schedule: { state?: string | null; configured: boolean; loaded: boolean };
  onboarding?: {
    phase?: string | null;
    status?: string | null;
    errorCode?: string | null;
  } | null;
};

const API_RESOURCE_LABELS = [
  ['cycles', 'com_ui_whoop_cycles'],
  ['recovery', 'com_ui_whoop_recovery'],
  ['sleep', 'com_ui_whoop_sleep'],
  ['workout', 'com_ui_whoop_workouts'],
  ['profile', 'com_ui_whoop_profile'],
  ['body_measurement', 'com_ui_whoop_body'],
] as const;
const STATUS_POLL_MS = 5_000;
const STATUS_POLL_LIMIT_MS = 11 * 60 * 1_000;
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

function WhoopConnection() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [status, setStatus] = useState<WhoopStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [operation, setOperation] = useState<
    'connect' | 'complete' | 'import' | 'evidence' | 'disconnect' | null
  >(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('viventium://oauth/whoop');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [showManualCallback, setShowManualCallback] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  const refreshSequenceRef = useRef(0);
  const pollStartedAtRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const next = await request.get<WhoopStatus>(
        `${apiBaseUrl()}/api/viventium/health/whoop/status`,
      );
      if (sequence === refreshSequenceRef.current) {
        setStatus(next);
        setStatusError(false);
      }
    } catch {
      if (sequence === refreshSequenceRef.current) {
        setStatusError(true);
      }
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return () => {
      refreshSequenceRef.current += 1;
    };
  }, [refreshStatus]);

  const manualCallbackVisible =
    showManualCallback ||
    status?.state === 'authorization_pending' ||
    status?.state === 'authorizing';
  const shouldPoll = manualCallbackVisible || status?.state === 'importing';
  useEffect(() => {
    if (!shouldPoll || pollExpired) {
      return;
    }
    pollStartedAtRef.current ??= Date.now();
    const timer = window.setInterval(() => {
      if (
        pollStartedAtRef.current != null &&
        Date.now() - pollStartedAtRef.current >= STATUS_POLL_LIMIT_MS
      ) {
        setPollExpired(true);
        return;
      }
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pollExpired, refreshStatus, shouldPoll]);

  useEffect(() => {
    if (!shouldPoll) {
      pollStartedAtRef.current = null;
      setPollExpired(false);
    }
    if (status?.state === 'connected') {
      setShowManualCallback(false);
      setCallbackUrl('');
      setClientSecret('');
    }
  }, [shouldPoll, status?.state]);

  const authorizationDegraded = status?.authorizationRecoveryRequired === true;

  const issueMessageKey = useMemo(() => {
    const code = authorizationDegraded ? 'authorization_failed' : status?.onboarding?.errorCode;
    const known: Record<string, string> = {
      authorization_failed: 'com_ui_whoop_error_authorization_failed',
      history_import_failed: 'com_ui_whoop_error_history_import_failed',
      history_partial: 'com_ui_whoop_error_history_partial',
      history_failed: 'com_ui_whoop_error_history_import_failed',
      schedule_install_failed: 'com_ui_whoop_error_schedule_failed',
      provider_unavailable: 'com_ui_whoop_error_provider_unavailable',
    };
    return (code && known[code]) || 'com_ui_whoop_error_general';
  }, [authorizationDegraded, status?.onboarding?.errorCode]);

  const stateLabel = useMemo(() => {
    switch (status?.state) {
      case 'connected':
        return localize('com_ui_whoop_connected');
      case 'connected_no_data':
        return localize('com_ui_whoop_connected_import_pending');
      case 'authorization_pending':
      case 'authorizing':
        return localize('com_ui_whoop_waiting_for_consent');
      case 'importing':
        return localize('com_ui_whoop_importing_history');
      case 'degraded':
        return localize('com_ui_whoop_needs_attention');
      case 'ready_to_authorize':
        return localize('com_ui_whoop_ready_to_connect');
      default:
        return localize('com_ui_whoop_not_connected');
    }
  }, [localize, status?.state]);

  const showFailure = useCallback(() => {
    showToast({
      message: localize('com_ui_whoop_operation_error'),
      status: NotificationSeverity.ERROR,
    });
  }, [localize, showToast]);

  const beginAuthorization = useCallback(async () => {
    if (operation) {
      return;
    }
    const popup = window.open('', '_blank', 'width=680,height=800');
    if (!popup) {
      showToast({
        message: localize('com_ui_whoop_popup_blocked'),
        status: NotificationSeverity.ERROR,
      });
      return;
    }
    setOperation('connect');
    pollStartedAtRef.current = Date.now();
    setPollExpired(false);
    try {
      if (!status?.clientConfigured) {
        await request.post(`${apiBaseUrl()}/api/viventium/health/whoop/configure`, {
          clientId,
          clientSecret,
          redirectUri,
        });
      }
      const result = await request.post<{ authorizationUrl?: string }>(
        `${apiBaseUrl()}/api/viventium/health/whoop/authorize`,
        {},
      );
      if (!result?.authorizationUrl) {
        throw new Error('missing_authorization_url');
      }
      popup.location.href = result.authorizationUrl;
      setShowManualCallback(true);
      await refreshStatus();
    } catch {
      popup.close();
      showFailure();
    } finally {
      setOperation(null);
    }
  }, [
    clientId,
    clientSecret,
    operation,
    redirectUri,
    refreshStatus,
    showFailure,
    showToast,
    localize,
    status,
  ]);

  const completeManually = useCallback(async () => {
    if (operation || !callbackUrl.trim()) {
      return;
    }
    setOperation('complete');
    try {
      await request.post(`${apiBaseUrl()}/api/viventium/health/whoop/complete`, {
        callbackUrl: callbackUrl.trim(),
      });
      await refreshStatus();
    } catch {
      showFailure();
    } finally {
      setOperation(null);
    }
  }, [callbackUrl, operation, refreshStatus, showFailure]);

  const importExport = useCallback(
    async (file: File) => {
      if (operation) {
        return;
      }
      if (
        file.size === 0 ||
        file.size > MAX_EXPORT_BYTES ||
        !file.name.toLowerCase().endsWith('.zip')
      ) {
        showToast({
          message: localize('com_ui_whoop_export_invalid'),
          status: NotificationSeverity.ERROR,
        });
        return;
      }
      setOperation('import');
      try {
        await axios.post(`${apiBaseUrl()}/api/viventium/health/whoop/import`, file, {
          headers: { 'Content-Type': 'application/zip' },
          maxBodyLength: MAX_EXPORT_BYTES,
          maxContentLength: MAX_EXPORT_BYTES,
        });
        showToast({
          message: localize('com_ui_whoop_export_imported'),
          status: NotificationSeverity.SUCCESS,
        });
        await refreshStatus();
      } catch {
        showFailure();
      } finally {
        setOperation(null);
      }
    },
    [localize, operation, refreshStatus, showFailure, showToast],
  );

  const disconnect = useCallback(async () => {
    if (operation || !window.confirm(localize('com_ui_whoop_disconnect_confirm'))) {
      return;
    }
    setOperation('disconnect');
    try {
      await request.post(`${apiBaseUrl()}/api/viventium/health/whoop/disconnect`, {});
      await refreshStatus();
    } catch {
      showFailure();
    } finally {
      setOperation(null);
    }
  }, [localize, operation, refreshStatus, showFailure]);

  const importEvidence = useCallback(
    async (file: File) => {
      if (operation) {
        return;
      }
      if (
        file.size === 0 ||
        file.size > MAX_EVIDENCE_BYTES ||
        !['image/png', 'image/jpeg'].includes(file.type)
      ) {
        showToast({
          message: localize('com_ui_whoop_evidence_invalid'),
          status: NotificationSeverity.ERROR,
        });
        return;
      }
      setOperation('evidence');
      try {
        await axios.post(`${apiBaseUrl()}/api/viventium/health/whoop/evidence`, file, {
          headers: { 'Content-Type': file.type },
          maxBodyLength: MAX_EVIDENCE_BYTES,
          maxContentLength: MAX_EVIDENCE_BYTES,
        });
        showToast({
          message: localize('com_ui_whoop_evidence_imported'),
          status: NotificationSeverity.SUCCESS,
        });
        await refreshStatus();
      } catch {
        showFailure();
      } finally {
        setOperation(null);
      }
    },
    [localize, operation, refreshStatus, showFailure, showToast],
  );

  const itemCount = status?.latestApiRun?.itemCount;
  const canStartAuthorization =
    status?.clientConfigured === true &&
    (authorizationDegraded ||
      (status.authorized === true && status.state === 'connected_no_data') ||
      (status.authorized === false &&
        (status.state === 'ready_to_authorize' || status.state === 'degraded')));

  return (
    <section
      className="rounded-xl border border-border-light bg-surface-primary p-4"
      aria-label={localize('com_ui_whoop_health')}
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            {localize('com_ui_whoop_health')}
          </h3>
          <p className="mt-1 text-xs text-text-secondary">
            {localize('com_ui_whoop_health_description')}
          </p>
        </div>
        <span
          className="rounded-full border border-border-light bg-surface-secondary px-2.5 py-1 text-xs text-text-secondary"
          aria-live="polite"
        >
          {stateLabel}
        </span>
      </div>

      {!status && !statusError && <Spinner className="icon-sm" />}
      {statusError && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-secondary p-3">
          <p className="text-xs text-text-secondary">
            {localize('com_ui_whoop_status_unavailable')}
          </p>
          <Button variant="outline" onClick={() => void refreshStatus()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}

      {status && (
        <div className="space-y-3">
          {status.state === 'degraded' && (
            <div className="rounded-lg border border-border-light bg-surface-secondary p-3">
              <p className="text-sm font-medium text-text-primary">
                {localize('com_ui_whoop_recovery_title')}
              </p>
              <p className="mt-1 text-xs text-text-secondary">{localize(issueMessageKey)}</p>
              <Button className="mt-3" variant="outline" onClick={() => void refreshStatus()}>
                {localize('com_ui_whoop_refresh_status')}
              </Button>
            </div>
          )}

          {pollExpired && (
            <div className="rounded-lg border border-border-light bg-surface-secondary p-3">
              <p className="text-xs text-text-secondary">
                {localize('com_ui_whoop_consent_expired')}
              </p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => {
                  pollStartedAtRef.current = Date.now();
                  setPollExpired(false);
                  void refreshStatus();
                }}
              >
                {localize('com_ui_retry')}
              </Button>
            </div>
          )}

          {status.state === 'setup_required' && (
            <div className="space-y-3 rounded-lg border border-border-light bg-surface-secondary p-3">
              <div>
                <p className="text-sm font-medium">{localize('com_ui_whoop_setup_title')}</p>
                <p className="mt-1 text-xs text-text-secondary">
                  {localize('com_ui_whoop_setup_description')}{' '}
                  <a
                    className="text-primary underline"
                    href="https://developer.whoop.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {localize('com_ui_whoop_open_developer_portal')}
                  </a>
                </p>
              </div>
              <label className="block text-xs text-text-secondary">
                {localize('com_ui_whoop_client_id')}
                <input
                  className="mt-1 w-full rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="block text-xs text-text-secondary">
                {localize('com_ui_whoop_client_secret')}
                <input
                  type="password"
                  className="mt-1 w-full rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="block text-xs text-text-secondary">
                {localize('com_ui_whoop_redirect_uri')}
                <input
                  className="mt-1 w-full rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary"
                  value={redirectUri}
                  onChange={(event) => setRedirectUri(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <p className="text-xs text-text-secondary">{localize('com_ui_whoop_setup_limit')}</p>
              <Button
                onClick={() => void beginAuthorization()}
                disabled={
                  operation != null ||
                  !clientId.trim() ||
                  !clientSecret.trim() ||
                  !redirectUri.trim()
                }
              >
                {operation === 'connect' ? (
                  <Spinner className="icon-sm" />
                ) : (
                  localize('com_ui_whoop_save_connect')
                )}
              </Button>
            </div>
          )}

          {canStartAuthorization && (
            <Button onClick={() => void beginAuthorization()} disabled={operation != null}>
              {operation === 'connect' ? (
                <Spinner className="icon-sm" />
              ) : (
                localize('com_ui_whoop_connect')
              )}
            </Button>
          )}

          {manualCallbackVisible && status.state !== 'connected' && (
            <div className="space-y-2 rounded-lg border border-border-light bg-surface-secondary p-3">
              <p className="text-xs text-text-secondary">
                {localize('com_ui_whoop_callback_fallback')}
              </p>
              <label className="block text-xs text-text-secondary">
                {localize('com_ui_whoop_callback_url')}
                <textarea
                  rows={2}
                  className="mt-1 w-full resize-y rounded-md border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary"
                  value={callbackUrl}
                  onChange={(event) => setCallbackUrl(event.target.value)}
                />
              </label>
              <Button
                onClick={() => void completeManually()}
                disabled={operation != null || !callbackUrl.trim()}
              >
                {operation === 'complete' ? (
                  <Spinner className="icon-sm" />
                ) : (
                  localize('com_ui_whoop_finish_connection')
                )}
              </Button>
            </div>
          )}

          {status.authorized && (
            <div className="rounded-lg border border-border-light p-3">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-text-secondary">
                    {localize('com_ui_whoop_api_items')}
                  </p>
                  <p className="text-2xl font-semibold text-text-primary">{itemCount ?? '—'}</p>
                </div>
                <p className="text-xs text-text-secondary">
                  {status.schedule.loaded
                    ? localize('com_ui_whoop_daily_active')
                    : localize('com_ui_whoop_daily_inactive')}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {API_RESOURCE_LABELS.map(([resource, label]) => {
                  const row = status.coverage.api[resource];
                  return (
                    <div key={resource} className="rounded-md bg-surface-secondary p-2">
                      <p className="text-xs text-text-secondary">{localize(label)}</p>
                      <p className="text-sm font-medium text-text-primary">{row?.items ?? '—'}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border-light bg-surface-secondary p-3">
            <p className="text-sm font-medium text-text-primary">
              {localize('com_ui_whoop_export_title')}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              {localize('com_ui_whoop_journal_export_gap')}
            </p>
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) {
                  void importExport(file);
                }
              }}
            />
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={operation != null}
            >
              {operation === 'import' ? (
                <Spinner className="icon-sm" />
              ) : (
                localize('com_ui_whoop_import_export')
              )}
            </Button>
          </div>

          <div className="rounded-lg border border-border-light bg-surface-secondary p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {localize('com_ui_whoop_manual_evidence_title')}
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  {localize('com_ui_whoop_stress_manual_gap')}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_whoop_manual_evidence_count')}
                </p>
                <p className="text-lg font-semibold text-text-primary">
                  {status.manualEvidence?.itemCount ?? 0}
                </p>
              </div>
            </div>
            <input
              ref={evidenceInputRef}
              className="hidden"
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) {
                  void importEvidence(file);
                }
              }}
            />
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => evidenceInputRef.current?.click()}
              disabled={operation != null}
            >
              {operation === 'evidence' ? (
                <Spinner className="icon-sm" />
              ) : (
                localize('com_ui_whoop_add_evidence')
              )}
            </Button>
          </div>

          {status.authorized && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => void disconnect()}
                disabled={operation != null}
              >
                {operation === 'disconnect' ? (
                  <Spinner className="icon-sm" />
                ) : (
                  localize('com_ui_whoop_disconnect')
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default WhoopConnection;
