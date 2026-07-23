/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Select the provider-specific setup flow from the shared channel contract.
 * === VIVENTIUM END ===
 */

import type { ConnectedChannel, ConnectedChannelConnectRequest } from 'librechat-data-provider';
import SlackSetup from './SlackSetup';
import TelegramSetup from './TelegramSetup';
import WhatsAppSetup from './WhatsAppSetup';

export default function ChannelSetup({
  channel,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  channel: ConnectedChannel;
  isSubmitting: boolean;
  onCancel: () => void;
  onSubmit: (input: ConnectedChannelConnectRequest) => void;
}) {
  if (channel === 'telegram') {
    return <TelegramSetup isSubmitting={isSubmitting} onCancel={onCancel} onSubmit={onSubmit} />;
  }
  if (channel === 'slack') {
    return <SlackSetup isSubmitting={isSubmitting} onCancel={onCancel} onSubmit={onSubmit} />;
  }
  return <WhatsAppSetup isSubmitting={isSubmitting} onCancel={onCancel} onSubmit={onSubmit} />;
}
