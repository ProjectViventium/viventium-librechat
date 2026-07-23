/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Guide server-manifest Slack Socket Mode setup without browser-stored secrets.
 * === VIVENTIUM END ===
 */

import { useMemo, useRef, useState } from 'react';
import type { SlackChannelConnectRequest } from 'librechat-data-provider';
import { Button, Spinner } from '@librechat/client';
import { useSlackManifestQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { SetupActions, SetupField, SetupPanel, fieldClassName } from './SetupField';

export default function SlackSetup({
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  isSubmitting: boolean;
  onCancel: () => void;
  onSubmit: (input: SlackChannelConnectRequest) => void;
}) {
  const localize = useLocalize();
  const manifestQuery = useSlackManifestQuery();
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const manifestRef = useRef<HTMLTextAreaElement>(null);
  const manifestText = useMemo(
    () =>
      manifestQuery.data?.manifest ? JSON.stringify(manifestQuery.data.manifest, null, 2) : '',
    [manifestQuery.data],
  );

  return (
    <SetupPanel>
      <p className="text-xs text-text-secondary">
        {localize('com_ui_connected_channels_slack_instructions')}
      </p>
      <a
        href="https://api.slack.com/apps?new_app=1"
        target="_blank"
        rel="noreferrer"
        className="inline-flex text-sm font-medium text-primary hover:underline"
      >
        {localize('com_ui_connected_channels_slack_open_apps')}
      </a>
      <label className="block space-y-1 text-xs text-text-secondary">
        <span>{localize('com_ui_connected_channels_slack_manifest')}</span>
        {manifestQuery.isLoading && <Spinner className="icon-sm" />}
        {manifestQuery.isError && (
          <span role="alert">{localize('com_ui_connected_channels_slack_manifest_error')}</span>
        )}
        <textarea
          ref={manifestRef}
          readOnly
          rows={8}
          value={manifestText}
          className={`${fieldClassName} resize-y font-mono text-xs`}
        />
      </label>
      <div className="space-y-1">
        <Button
          type="button"
          variant="outline"
          disabled={!manifestText}
          onClick={async () => {
            setCopyState('idle');
            try {
              if (!navigator.clipboard?.writeText) {
                throw new Error('Clipboard is unavailable');
              }
              await navigator.clipboard.writeText(manifestText);
              setCopyState('copied');
            } catch {
              manifestRef.current?.focus();
              manifestRef.current?.select();
              setCopyState('error');
            }
          }}
        >
          {localize('com_ui_connected_channels_slack_manifest_copy')}
        </Button>
        {copyState === 'copied' && (
          <p role="status" aria-live="polite" className="text-xs text-text-secondary">
            {localize('com_ui_connected_channels_slack_manifest_copied')}
          </p>
        )}
        {copyState === 'error' && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {localize('com_ui_connected_channels_slack_manifest_copy_error')}
          </p>
        )}
      </div>
      <form
        aria-label={localize('com_ui_connected_channels_setup_form', {
          provider: localize('com_ui_connected_channels_slack'),
        })}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedAppToken = appToken.trim();
          const trimmedBotToken = botToken.trim();
          if (!trimmedAppToken || !trimmedBotToken) {
            return;
          }
          onSubmit({ channel: 'slack', appToken: trimmedAppToken, botToken: trimmedBotToken });
        }}
      >
        <SetupField
          required
          type="password"
          name="slackAppToken"
          value={appToken}
          label={localize('com_ui_connected_channels_slack_app_token')}
          onChange={(event) => setAppToken(event.target.value)}
        />
        <SetupField
          required
          type="password"
          name="slackBotToken"
          value={botToken}
          label={localize('com_ui_connected_channels_slack_bot_token')}
          onChange={(event) => setBotToken(event.target.value)}
        />
        <SetupActions isSubmitting={isSubmitting} onCancel={onCancel} />
      </form>
    </SetupPanel>
  );
}
