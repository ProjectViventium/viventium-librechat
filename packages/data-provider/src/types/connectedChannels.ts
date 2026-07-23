/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels API contract.
 * Purpose: Share secret-safe channel lifecycle and administration types across the UI and API.
 * === VIVENTIUM END ===
 */

export type ConnectedChannel = 'telegram' | 'slack' | 'whatsapp';

export type ConnectedChannelState =
  | 'not_configured'
  | 'needs_vendor_step'
  | 'verifying'
  | 'connected'
  | 'degraded'
  | 'reauth_required'
  | 'disconnected';

export interface ConnectedChannelSummary {
  channel: ConnectedChannel;
  state: ConnectedChannelState;
  displayName?: string;
  issueCode?: string;
  callbackUrl?: string;
  lastCheckedAt?: string;
}

export interface ConnectedChannelsResponse {
  channels: ConnectedChannelSummary[];
}

export interface ConnectedChannelAvailability {
  channel: ConnectedChannel;
  available: boolean;
}

export interface ConnectedChannelAvailabilityResponse {
  channels: ConnectedChannelAvailability[];
}

export interface TelegramChannelConnectRequest {
  channel: 'telegram';
  botToken: string;
  dmPolicy: 'PAIRING';
}

export interface SlackChannelConnectRequest {
  channel: 'slack';
  appToken: string;
  botToken: string;
}

export interface WhatsAppChannelConnectRequest {
  channel: 'whatsapp';
  publicBaseUrl?: string;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

export type ConnectedChannelConnectRequest =
  TelegramChannelConnectRequest | SlackChannelConnectRequest | WhatsAppChannelConnectRequest;

export interface ConnectedChannelResponse {
  channel: ConnectedChannelSummary;
}

export interface ConnectedChannelTestResponse extends ConnectedChannelResponse {
  ok: boolean;
  message: string;
}

export interface SlackAppManifest {
  display_information: {
    name: string;
    description?: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online?: boolean;
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: {
      bot_events: string[];
    };
    socket_mode_enabled: boolean;
  };
}

export interface SlackManifestResponse {
  manifest: SlackAppManifest;
}

export interface ChannelPairingCodeResponse {
  pairingCode: string;
  expiresAt: string;
}
