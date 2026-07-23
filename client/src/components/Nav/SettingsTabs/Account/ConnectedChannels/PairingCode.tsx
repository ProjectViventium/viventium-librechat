/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels one-use pairing.
 * Purpose: Let the signed-in user create and copy their own short-lived pairing code without persisting it.
 * === VIVENTIUM END ===
 */

import { useEffect, useRef, useState } from 'react';
import type { ConnectedChannel } from 'librechat-data-provider';
import { Button, Spinner } from '@librechat/client';
import { useCreateChannelPairingCodeMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

type PairingCodeValue = {
  code: string;
  expiresAt: number;
};

export default function PairingCode({
  channel,
  disabled,
  providerLabel,
}: {
  channel: ConnectedChannel;
  disabled: boolean;
  providerLabel: string;
}) {
  const localize = useLocalize();
  const pairingMutation = useCreateChannelPairingCodeMutation();
  const codeRef = useRef<HTMLOutputElement>(null);
  const [pairing, setPairing] = useState<PairingCodeValue | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    if (!pairing) {
      return;
    }
    const remainingMs = pairing.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setPairing(null);
      setIsExpired(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setPairing(null);
      setIsExpired(true);
      setCopyState('idle');
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  useEffect(() => {
    if (pairing) {
      codeRef.current?.focus();
    }
  }, [pairing]);

  const createCode = () => {
    setPairing(null);
    setIsExpired(false);
    setHasError(false);
    setCopyState('idle');
    pairingMutation.mutate(channel, {
      onSuccess: (response) => {
        const expiresAt = Date.parse(response.expiresAt);
        if (!response.pairingCode || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          setIsExpired(true);
          return;
        }
        setPairing({ code: response.pairingCode, expiresAt });
      },
      onError: () => setHasError(true),
    });
  };

  let actionLabel = localize('com_ui_connected_channels_pairing_code_create', {
    provider: providerLabel,
  });
  if (pairingMutation.isLoading) {
    actionLabel = localize('com_ui_connected_channels_pairing_code_creating', {
      provider: providerLabel,
    });
  } else if (hasError) {
    actionLabel = localize('com_ui_connected_channels_pairing_code_retry', {
      provider: providerLabel,
    });
  }

  if (pairing) {
    const expiry = new Date(pairing.expiresAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    return (
      <div className="mt-3 space-y-2 rounded-lg border border-border-light bg-surface-secondary p-3">
        <p className="text-xs text-text-secondary">
          {localize('com_ui_connected_channels_pairing_code_description', {
            provider: providerLabel,
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <output
            ref={codeRef}
            tabIndex={-1}
            aria-label={localize('com_ui_connected_channels_pairing_code_label', {
              provider: providerLabel,
            })}
            className="select-all rounded-md border border-border-light bg-surface-primary px-3 py-2 font-mono text-sm font-semibold tracking-wide text-text-primary"
          >
            {pairing.code}
          </output>
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                if (!navigator.clipboard?.writeText) {
                  throw new Error('Clipboard is unavailable');
                }
                await navigator.clipboard.writeText(pairing.code);
                setCopyState('copied');
              } catch {
                setCopyState('error');
              }
            }}
          >
            {localize('com_ui_connected_channels_pairing_code_copy')}
          </Button>
        </div>
        <p className="text-xs text-text-secondary">
          <time dateTime={new Date(pairing.expiresAt).toISOString()}>
            {localize('com_ui_connected_channels_pairing_code_expires', { time: expiry })}
          </time>
        </p>
        {copyState === 'copied' && (
          <p role="status" aria-live="polite" className="text-xs text-text-secondary">
            {localize('com_ui_connected_channels_pairing_code_copied')}
          </p>
        )}
        {copyState === 'error' && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {localize('com_ui_connected_channels_pairing_code_copy_error')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {hasError && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {localize('com_ui_connected_channels_pairing_code_error')}
        </p>
      )}
      {isExpired && !hasError && (
        <p role="status" aria-live="polite" className="text-xs text-text-secondary">
          {localize('com_ui_connected_channels_pairing_code_expired')}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        aria-busy={pairingMutation.isLoading}
        disabled={disabled || pairingMutation.isLoading}
        onClick={createCode}
      >
        {pairingMutation.isLoading && <Spinner className="icon-sm mr-2" />}
        {actionLabel}
      </Button>
    </div>
  );
}
