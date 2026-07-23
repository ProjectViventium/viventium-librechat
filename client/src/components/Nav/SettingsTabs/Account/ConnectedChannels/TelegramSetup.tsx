/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Guide official Telegram Bot API setup with secure pairing defaults.
 * === VIVENTIUM END ===
 */

import { useState } from 'react';
import type { TelegramChannelConnectRequest } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { SetupActions, SetupField, SetupPanel } from './SetupField';

export default function TelegramSetup({
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  isSubmitting: boolean;
  onCancel: () => void;
  onSubmit: (input: TelegramChannelConnectRequest) => void;
}) {
  const localize = useLocalize();
  const [botToken, setBotToken] = useState('');

  return (
    <SetupPanel>
      <p className="text-xs text-text-secondary">
        {localize('com_ui_connected_channels_telegram_instructions')}
      </p>
      <a
        href="https://t.me/BotFather"
        target="_blank"
        rel="noreferrer"
        className="inline-flex text-sm font-medium text-primary hover:underline"
      >
        {localize('com_ui_connected_channels_telegram_open_botfather')}
      </a>
      <form
        aria-label={localize('com_ui_connected_channels_setup_form', {
          provider: localize('com_ui_connected_channels_telegram'),
        })}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedToken = botToken.trim();
          if (!trimmedToken) {
            return;
          }
          onSubmit({ channel: 'telegram', botToken: trimmedToken, dmPolicy: 'PAIRING' });
        }}
      >
        <SetupField
          required
          type="password"
          name="telegramBotToken"
          value={botToken}
          label={localize('com_ui_connected_channels_telegram_token')}
          onChange={(event) => setBotToken(event.target.value)}
        />
        <p className="text-xs text-text-secondary">
          {localize('com_ui_connected_channels_telegram_pairing')}
        </p>
        <SetupActions isSubmitting={isSubmitting} onCancel={onCancel} />
      </form>
    </SetupPanel>
  );
}
