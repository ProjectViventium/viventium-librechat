/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels pairing and administration.
 * Purpose: Prove pairing is self-service while global setup remains admin-only and secret-safe.
 * === VIVENTIUM END ===
 */

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import ConnectedChannels from './ConnectedChannels';

const mockUseAuthContext = jest.fn();
const mockUseConnectedChannelAvailabilityQuery = jest.fn();
const mockUseConnectedChannelsQuery = jest.fn();
const mockUseSlackManifestQuery = jest.fn();
const mockSave = jest.fn();
const mockTest = jest.fn();
const mockDisconnect = jest.fn();
const mockCreatePairingCode = jest.fn();
const mockUseCreatePairingCodeMutation = jest.fn();
const mockRefetch = jest.fn();
const mockAvailabilityRefetch = jest.fn();

jest.mock('librechat-data-provider', () => ({ SystemRoles: { ADMIN: 'ADMIN', USER: 'USER' } }), {
  virtual: true,
});

jest.mock(
  '@librechat/client',
  () => ({
    Button: ({
      children,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
      <button {...props}>{children}</button>
    ),
    Spinner: () => <span data-testid="spinner" />,
    useToastContext: () => ({ showToast: jest.fn() }),
  }),
  { virtual: true },
);

jest.mock('~/data-provider', () => ({
  useConnectedChannelAvailabilityQuery: () => mockUseConnectedChannelAvailabilityQuery(),
  useConnectedChannelsQuery: () => mockUseConnectedChannelsQuery(),
  useSlackManifestQuery: () => mockUseSlackManifestQuery(),
  useSaveConnectedChannelMutation: () => ({ isLoading: false, mutate: mockSave }),
  useTestConnectedChannelMutation: () => ({ isLoading: false, mutate: mockTest }),
  useDisconnectConnectedChannelMutation: () => ({ isLoading: false, mutate: mockDisconnect }),
  useCreateChannelPairingCodeMutation: () => mockUseCreatePairingCodeMutation(),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useLocalize: () => (key: string, params?: Record<string, string>) => {
    const copy: Record<string, string> = {
      com_ui_connected_channels: 'Connected Channels',
      com_ui_connected_channels_description:
        'Connect messaging channels to the local Viventium runtime. Provider approval is still required.',
      com_ui_connected_channels_loading: 'Loading connected channels',
      com_ui_connected_channels_load_error: 'Connected channels could not be loaded.',
      com_ui_connected_channels_retry: 'Try again',
      com_ui_connected_channels_not_configured: 'Not configured',
      com_ui_connected_channels_needs_vendor_step: 'Provider step required',
      com_ui_connected_channels_verifying: 'Verifying',
      com_ui_connected_channels_connected: 'Connected',
      com_ui_connected_channels_degraded: 'Needs attention',
      com_ui_connected_channels_reauth_required: 'Sign-in required',
      com_ui_connected_channels_disconnected: 'Disconnected',
      com_ui_connected_channels_set_up: 'Set up',
      com_ui_connected_channels_repair: 'Repair',
      com_ui_connected_channels_test: 'Test',
      com_ui_connected_channels_disconnect: 'Disconnect',
      com_ui_connected_channels_cancel: 'Cancel',
      com_ui_connected_channels_confirm_disconnect: 'Disconnect this channel?',
      com_ui_connected_channels_pairing_code_create: 'Connect {{provider}}',
      com_ui_connected_channels_pairing_code_creating: 'Creating {{provider}} code',
      com_ui_connected_channels_pairing_code_description:
        'In a private message to the Viventium bot on {{provider}}, send /pair followed by this code. Do not share it. It works once and expires soon.',
      com_ui_connected_channels_pairing_code_label: '{{provider}} one-use pairing code',
      com_ui_connected_channels_pairing_code_copy: 'Copy pairing code',
      com_ui_connected_channels_pairing_code_copied: 'Pairing code copied',
      com_ui_connected_channels_pairing_code_copy_error:
        'The code could not be copied. Select it and copy it manually.',
      com_ui_connected_channels_pairing_code_expires: 'Expires soon',
      com_ui_connected_channels_pairing_code_expired:
        'This pairing code expired. Create a new one.',
      com_ui_connected_channels_pairing_code_error:
        'A pairing code could not be created. This channel may not be ready. Try again, or ask the person who manages this Viventium installation to check it.',
      com_ui_connected_channels_pairing_code_retry: 'Try {{provider}} again',
      com_ui_connected_channels_pairing_description:
        'Connect a private chat to the Viventium account you are signed in to. Create the temporary code yourself, then send it to the Viventium bot from your own messaging account.',
      com_ui_connected_channels_pairing_group: '{{provider}} pairing',
      com_ui_connected_channels_pairing_heading: 'Connect your messaging accounts',
      com_ui_connected_channels_pairing_load_error:
        'Messaging channel availability could not be loaded.',
      com_ui_connected_channels_pairing_loading: 'Checking available messaging channels',
      com_ui_connected_channels_pairing_refresh: 'Refresh available channels',
      com_ui_connected_channels_pairing_unavailable:
        '{{provider}} is not ready on this Viventium installation. Ask the person who manages it to set up the channel.',
      com_ui_connected_channels_save: 'Save connection',
      com_ui_connected_channels_telegram: 'Telegram',
      com_ui_connected_channels_slack: 'Slack',
      com_ui_connected_channels_whatsapp: 'WhatsApp',
      com_ui_connected_channels_telegram_description:
        'Uses the official Telegram Bot API with local long polling.',
      com_ui_connected_channels_telegram_open_botfather: 'Open BotFather',
      com_ui_connected_channels_telegram_token: 'Bot token',
      com_ui_connected_channels_telegram_pairing:
        'New people must be approved before Viventium responds.',
      com_ui_connected_channels_slack_description:
        'Uses Slack Socket Mode; no public event URL is required.',
      com_ui_connected_channels_slack_open_apps: 'Open Slack app setup',
      com_ui_connected_channels_slack_manifest: 'Slack app manifest',
      com_ui_connected_channels_slack_manifest_copy: 'Copy Slack manifest',
      com_ui_connected_channels_slack_manifest_copied: 'Slack manifest copied',
      com_ui_connected_channels_slack_manifest_copy_error:
        'The manifest could not be copied. Select the manifest and copy it manually.',
      com_ui_connected_channels_slack_app_token: 'App token (xapp-)',
      com_ui_connected_channels_slack_bot_token: 'Bot token (xoxb-)',
      com_ui_connected_channels_whatsapp_description:
        'Uses the official WhatsApp Cloud API, not an unofficial QR session.',
      com_ui_connected_channels_whatsapp_https_required:
        'WhatsApp requires a stable public HTTPS address that forwards to this Viventium installation. Localhost and private-network addresses cannot receive Meta webhooks.',
      com_ui_connected_channels_whatsapp_instructions:
        'Paste your public Viventium API address below, or leave it blank when public access is already configured for this installation. Viventium builds the secret callback path; after saving, copy that generated callback URL into Meta.',
      com_ui_connected_channels_whatsapp_open_https_guide: 'Open the public HTTPS setup guide',
      com_ui_connected_channels_whatsapp_open_meta: 'Open Meta Cloud API setup',
      com_ui_connected_channels_whatsapp_phone_number_id: 'Phone number ID',
      com_ui_connected_channels_whatsapp_public_base_url: 'Public Viventium HTTPS address',
      com_ui_connected_channels_whatsapp_business_account_id: 'WhatsApp Business Account ID',
      com_ui_connected_channels_whatsapp_access_token: 'Cloud API access token',
      com_ui_connected_channels_whatsapp_app_secret: 'Meta app secret',
      com_ui_connected_channels_whatsapp_verify_token: 'Webhook verify token',
      com_ui_connected_channels_whatsapp_callback_url:
        'Use this server-generated callback URL in Meta',
      com_ui_connected_channels_issue_approval_required:
        'Ask a provider administrator to approve the app, then test again.',
      com_ui_connected_channels_issue_connection_unavailable:
        'Check the local runtime and network, then test this channel again.',
      com_ui_connected_channels_issue_invalid_credentials:
        'Open Repair, replace the invalid or expired credentials, and test again.',
      com_ui_connected_channels_issue_missing_permission:
        'Add the required provider permission, reinstall the app if prompted, then test again.',
      com_ui_connected_channels_issue_public_https_required:
        'Configure a reachable public HTTPS address, then reconnect WhatsApp.',
      com_ui_connected_channels_issue_rate_limited:
        'The provider is rate limiting checks. Wait a few minutes, then test again.',
      com_ui_connected_channels_issue_delivery_uncertain:
        'The provider may have received the last reply, but Viventium could not confirm it. Check the conversation before sending that message again.',
      com_ui_connected_channels_issue_webhook_verification_failed:
        'Confirm the callback and verify token in Meta, then retry verification.',
      com_ui_connected_channels_issue_transport_unavailable:
        'Update or restart Viventium, then test the channel again.',
      com_ui_connected_channels_issue_connection_test_failed:
        'The provider test failed. Check the connection details and retry.',
      com_ui_connected_channels_issue_webhook_verification_required:
        'Finish webhook verification at the provider, then test again.',
      com_ui_connected_channels_issue_credentials_unavailable:
        'Saved credentials could not be decrypted. Reconnect this channel.',
      com_ui_connected_channels_issue_worker_start_failed:
        'The channel worker could not start. Test it, then restart Viventium if needed.',
      com_ui_connected_channels_issue_worker_stop_failed:
        'The channel worker did not stop cleanly. Restart Viventium before reconnecting.',
      com_ui_connected_channels_issue_connection_conflict:
        'Another process is using this provider connection. Stop it, then test again.',
      com_ui_connected_channels_issue_webhook_in_use:
        'Telegram is using a webhook elsewhere. Remove it before enabling local polling.',
      com_ui_connected_channels_issue_operator_managed:
        'This Telegram connection is managed by Custom Settings Install. Test or restart it from the Viventium command line; do not connect the same bot here.',
    };
    if (key === 'com_ui_connected_channels_region') {
      return `${params?.provider} channel`;
    }
    if (key === 'com_ui_connected_channels_pairing_code_expires') {
      return `Expires at ${params?.time}`;
    }
    return (copy[key] ?? key).replace('{{provider}}', params?.provider ?? '');
  },
}));

jest.mock('~/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));

describe('ConnectedChannels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuthContext.mockReturnValue({ user: { role: 'ADMIN' } });
    mockUseCreatePairingCodeMutation.mockReturnValue({
      isLoading: false,
      mutate: mockCreatePairingCode,
    });
    mockUseConnectedChannelAvailabilityQuery.mockReturnValue({
      data: {
        channels: [
          { channel: 'telegram', available: true },
          { channel: 'slack', available: false },
          { channel: 'whatsapp', available: false },
        ],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: mockAvailabilityRefetch,
    });
    mockUseSlackManifestQuery.mockReturnValue({
      data: {
        manifest: {
          display_information: { name: 'Viventium' },
          features: { bot_user: { display_name: 'Viventium' } },
          oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write'] } },
          settings: {
            event_subscriptions: { bot_events: ['app_mention'] },
            socket_mode_enabled: true,
          },
        },
      },
      isLoading: false,
      isError: false,
    });
    mockUseConnectedChannelsQuery.mockReturnValue({
      data: {
        channels: [
          {
            channel: 'telegram',
            state: 'connected',
            displayName: '@viventium_test_bot',
          },
          {
            channel: 'slack',
            state: 'degraded',
            issueCode: 'missing_permission',
          },
          { channel: 'whatsapp', state: 'not_configured' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });
  });

  it('gives non-admin users self-service pairing without exposing global administration', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: 'USER' } });

    render(<ConnectedChannels />);

    expect(screen.getByText('Connect your messaging accounts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }));
    expect(mockCreatePairingCode).toHaveBeenCalledWith('telegram', expect.any(Object));
    const slack = screen.getByRole('group', { name: 'Slack pairing' });
    expect(within(slack).queryByRole('button', { name: 'Connect Slack' })).not.toBeInTheDocument();
    expect(within(slack).getByText(/Slack is not ready/)).toBeInTheDocument();
    expect(screen.queryByText('Connected Channels')).not.toBeInTheDocument();
    expect(mockUseConnectedChannelsQuery).not.toHaveBeenCalled();
  });

  it('does not request availability or show pairing without a signed-in user', () => {
    mockUseAuthContext.mockReturnValue({ user: null });

    render(<ConnectedChannels />);

    expect(screen.queryByText('Connect your messaging accounts')).not.toBeInTheDocument();
    expect(mockUseConnectedChannelAvailabilityQuery).not.toHaveBeenCalled();
    expect(mockUseConnectedChannelsQuery).not.toHaveBeenCalled();
  });

  it('announces availability loading without offering an unverified pairing action', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: 'USER' } });
    mockUseConnectedChannelAvailabilityQuery.mockReturnValue({
      isLoading: true,
      isError: false,
      isFetching: true,
      refetch: mockAvailabilityRefetch,
    });

    render(<ConnectedChannels />);

    expect(
      screen.getByRole('status', { name: 'Checking available messaging channels' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect Telegram/ })).not.toBeInTheDocument();
  });

  it('shows an accessible availability error and retries on demand', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: 'USER' } });
    mockUseConnectedChannelAvailabilityQuery.mockReturnValue({
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: mockAvailabilityRefetch,
    });

    render(<ConnectedChannels />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Messaging channel availability could not be loaded.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockAvailabilityRefetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes availability and disables duplicate refreshes while checking', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: 'USER' } });

    const { rerender } = render(<ConnectedChannels />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh available channels' }));
    expect(mockAvailabilityRefetch).toHaveBeenCalledTimes(1);

    mockUseConnectedChannelAvailabilityQuery.mockReturnValue({
      data: { channels: [{ channel: 'telegram', available: true }] },
      isLoading: false,
      isError: false,
      isFetching: true,
      refetch: mockAvailabilityRefetch,
    });
    rerender(<ConnectedChannels />);

    const refresh = screen.getByRole('button', { name: 'Refresh available channels' });
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('aria-busy', 'true');
  });

  it('shows shared status vocabulary and provider-specific truth', () => {
    render(<ConnectedChannels />);

    expect(screen.getByText('Connected Channels')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(
      screen.getByText('Uses the official WhatsApp Cloud API, not an unofficial QR session.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Add the required provider permission, reinstall the app if prompted, then test again.',
      ),
    ).toBeInTheDocument();
  });

  it('explains an uncertain delivery without encouraging a duplicate resend', () => {
    mockUseConnectedChannelsQuery.mockReturnValue({
      data: {
        channels: [
          {
            channel: 'telegram',
            state: 'connected',
            issueCode: 'delivery_uncertain',
          },
          { channel: 'slack', state: 'not_configured' },
          { channel: 'whatsapp', state: 'not_configured' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<ConnectedChannels />);

    expect(
      screen.getByText(
        'The provider may have received the last reply, but Viventium could not confirm it. Check the conversation before sending that message again.',
      ),
    ).toBeInTheDocument();
  });

  it('configures Telegram with a password field and pairing enabled', () => {
    render(<ConnectedChannels />);

    const telegram = screen.getByRole('region', { name: 'Telegram channel' });
    fireEvent.click(within(telegram).getByRole('button', { name: 'Repair' }));

    const tokenInput = within(telegram).getByLabelText('Bot token');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(within(telegram).getByRole('link', { name: 'Open BotFather' })).toHaveAttribute(
      'href',
      'https://t.me/BotFather',
    );
    expect(
      within(telegram).getByText('New people must be approved before Viventium responds.'),
    ).toBeInTheDocument();

    fireEvent.change(tokenInput, { target: { value: 'synthetic-telegram-token' } });
    fireEvent.submit(within(telegram).getByRole('form'));

    expect(mockSave).toHaveBeenCalledWith(
      {
        channel: 'telegram',
        botToken: 'synthetic-telegram-token',
        dmPolicy: 'PAIRING',
      },
      expect.any(Object),
    );
  });

  it('never persists channel secrets and clears the mounted form after save', () => {
    const storageWrite = jest.spyOn(Storage.prototype, 'setItem');
    mockSave.mockImplementationOnce((_input: object, callbacks: { onSuccess: () => void }) =>
      callbacks.onSuccess(),
    );
    render(<ConnectedChannels />);

    const telegram = screen.getByRole('region', { name: 'Telegram channel' });
    fireEvent.click(within(telegram).getByRole('button', { name: 'Repair' }));
    fireEvent.change(within(telegram).getByLabelText('Bot token'), {
      target: { value: 'synthetic-ephemeral-token' },
    });
    fireEvent.submit(within(telegram).getByRole('form'));

    expect(storageWrite).not.toHaveBeenCalled();
    expect(within(telegram).queryByLabelText('Bot token')).not.toBeInTheDocument();
    storageWrite.mockRestore();
  });

  it('guides Slack Socket Mode setup with a copyable secret-free manifest and distinct secret fields', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<ConnectedChannels />);

    const slack = screen.getByRole('region', { name: 'Slack channel' });
    fireEvent.click(within(slack).getByRole('button', { name: 'Repair' }));

    const manifest = (within(slack).getByLabelText('Slack app manifest') as HTMLTextAreaElement)
      .value;
    expect(manifest).toContain('"socket_mode_enabled": true');
    expect(manifest).not.toMatch(/xapp-|xoxb-/);
    expect(within(slack).getByRole('link', { name: 'Open Slack app setup' })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps?new_app=1',
    );
    await act(async () => {
      fireEvent.click(within(slack).getByRole('button', { name: 'Copy Slack manifest' }));
    });
    expect(writeText).toHaveBeenCalledWith(manifest);
    expect(within(slack).getByRole('status')).toHaveTextContent('Slack manifest copied');
    expect(within(slack).getByLabelText('App token (xapp-)')).toHaveAttribute('type', 'password');
    expect(within(slack).getByLabelText('Bot token (xoxb-)')).toHaveAttribute('type', 'password');

    fireEvent.change(within(slack).getByLabelText('App token (xapp-)'), {
      target: { value: 'xapp-synthetic' },
    });
    fireEvent.change(within(slack).getByLabelText('Bot token (xoxb-)'), {
      target: { value: 'xoxb-synthetic' },
    });
    fireEvent.submit(within(slack).getByRole('form'));

    expect(mockSave).toHaveBeenCalledWith(
      { channel: 'slack', appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
      expect.any(Object),
    );
  });

  it('gives a manual-selection fallback when Slack manifest clipboard access is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(new Error('clipboard blocked')) },
    });
    render(<ConnectedChannels />);

    const slack = screen.getByRole('region', { name: 'Slack channel' });
    fireEvent.click(within(slack).getByRole('button', { name: 'Repair' }));
    await act(async () => {
      fireEvent.click(within(slack).getByRole('button', { name: 'Copy Slack manifest' }));
    });

    expect(
      within(slack).getByText(
        'The manifest could not be copied. Select the manifest and copy it manually.',
      ),
    ).toHaveAttribute('role', 'alert');
    const manifest = within(slack).getByLabelText('Slack app manifest') as HTMLTextAreaElement;
    expect(manifest).toHaveFocus();
    expect(manifest.selectionStart).toBe(0);
    expect(manifest.selectionEnd).toBe(manifest.value.length);
  });

  it('guides the official WhatsApp Cloud API public HTTPS prerequisite in Settings', () => {
    render(<ConnectedChannels />);

    const whatsapp = screen.getByRole('region', { name: 'WhatsApp channel' });
    fireEvent.click(within(whatsapp).getByRole('button', { name: 'Set up' }));

    expect(
      within(whatsapp).getByText(
        'WhatsApp requires a stable public HTTPS address that forwards to this Viventium installation. Localhost and private-network addresses cannot receive Meta webhooks.',
      ),
    ).toBeInTheDocument();
    expect(within(whatsapp).getByLabelText('Public Viventium HTTPS address')).toHaveAttribute(
      'placeholder',
      'https://api.example.com',
    );
    expect(
      within(whatsapp).getByRole('link', { name: 'Open the public HTTPS setup guide' }),
    ).toHaveAttribute('href', expect.stringContaining('47_Remote_Access_and_Tunneling.md'));
    expect(within(whatsapp).getByLabelText('Cloud API access token')).toHaveAttribute(
      'type',
      'password',
    );
    expect(within(whatsapp).getByLabelText('Meta app secret')).toHaveAttribute('type', 'password');
    expect(within(whatsapp).getByLabelText('Webhook verify token')).toHaveAttribute(
      'type',
      'password',
    );
    expect(within(whatsapp).queryByText(/QR/i)).toHaveTextContent(
      'Uses the official WhatsApp Cloud API, not an unofficial QR session.',
    );
  });

  it('submits a normalized public HTTPS origin with WhatsApp credentials', () => {
    render(<ConnectedChannels />);

    const whatsapp = screen.getByRole('region', { name: 'WhatsApp channel' });
    fireEvent.click(within(whatsapp).getByRole('button', { name: 'Set up' }));
    fireEvent.change(within(whatsapp).getByLabelText('Public Viventium HTTPS address'), {
      target: { value: ' https://api.example.test ' },
    });
    fireEvent.change(within(whatsapp).getByLabelText('Phone number ID'), {
      target: { value: 'synthetic-phone-id' },
    });
    fireEvent.change(within(whatsapp).getByLabelText('WhatsApp Business Account ID'), {
      target: { value: 'synthetic-business-id' },
    });
    fireEvent.change(within(whatsapp).getByLabelText('Cloud API access token'), {
      target: { value: 'synthetic-cloud-token' },
    });
    fireEvent.change(within(whatsapp).getByLabelText('Meta app secret'), {
      target: { value: 'synthetic-app-secret' },
    });
    fireEvent.change(within(whatsapp).getByLabelText('Webhook verify token'), {
      target: { value: 'synthetic-verify-token' },
    });
    fireEvent.submit(within(whatsapp).getByRole('form'));
    expect(mockSave).toHaveBeenCalledWith(
      {
        channel: 'whatsapp',
        publicBaseUrl: 'https://api.example.test',
        phoneNumberId: 'synthetic-phone-id',
        businessAccountId: 'synthetic-business-id',
        accessToken: 'synthetic-cloud-token',
        appSecret: 'synthetic-app-secret',
        verifyToken: 'synthetic-verify-token',
      },
      expect.any(Object),
    );
  });

  it('shows the server-generated WhatsApp callback as read-only after setup', () => {
    mockUseConnectedChannelsQuery.mockReturnValue({
      data: {
        channels: [
          { channel: 'telegram', state: 'not_configured' },
          { channel: 'slack', state: 'not_configured' },
          {
            channel: 'whatsapp',
            state: 'connected',
            callbackUrl: 'https://example.invalid/api/viventium/channels/whatsapp/opaque-callback',
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<ConnectedChannels />);

    const whatsapp = screen.getByRole('region', { name: 'WhatsApp channel' });
    const callback = within(whatsapp).getByLabelText(
      'Use this server-generated callback URL in Meta',
    );
    expect(callback).toHaveAttribute('readonly');
    expect(callback).toHaveAttribute('type', 'url');
    expect(callback).toHaveValue(
      'https://example.invalid/api/viventium/channels/whatsapp/opaque-callback',
    );
  });

  it('tests connected channels and confirms before disconnecting', () => {
    render(<ConnectedChannels />);

    const telegram = screen.getByRole('region', { name: 'Telegram channel' });
    fireEvent.click(within(telegram).getByRole('button', { name: 'Test' }));
    expect(mockTest).toHaveBeenCalledWith('telegram', expect.any(Object));

    fireEvent.click(within(telegram).getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(within(telegram).getByText('Disconnect this channel?')).toBeInTheDocument();

    fireEvent.click(within(telegram).getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).toHaveBeenCalledWith('telegram', expect.any(Object));
  });

  it('creates, announces, and explicitly copies a one-use pairing code without making a link', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockCreatePairingCode.mockImplementationOnce(
      (_channel: string, callbacks: { onSuccess: (value: object) => void }) =>
        callbacks.onSuccess({
          pairingCode: 'ABCD-EFGH',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
    );
    render(<ConnectedChannels />);

    const telegram = screen.getByRole('group', { name: 'Telegram pairing' });
    fireEvent.click(within(telegram).getByRole('button', { name: 'Connect Telegram' }));

    expect(mockCreatePairingCode).toHaveBeenCalledWith('telegram', expect.any(Object));
    expect(within(telegram).getByText('ABCD-EFGH')).toHaveFocus();
    expect(
      within(telegram)
        .getByText(/Expires at/)
        .closest('time'),
    ).toHaveAttribute('dateTime');
    expect(within(telegram).queryByRole('link', { name: /ABCD-EFGH/ })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(telegram).getByRole('button', { name: 'Copy pairing code' }));
    });
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    expect(within(telegram).getByText('Pairing code copied')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('disables the pairing control and announces progress while a code is being created', () => {
    mockUseCreatePairingCodeMutation.mockReturnValue({
      isLoading: true,
      mutate: mockCreatePairingCode,
    });

    render(<ConnectedChannels />);

    const telegram = screen.getByRole('group', { name: 'Telegram pairing' });
    const button = within(telegram).getByRole('button', { name: 'Creating Telegram code' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('expires pairing codes locally and offers a fresh code', () => {
    jest.useFakeTimers();
    mockCreatePairingCode.mockImplementationOnce(
      (_channel: string, callbacks: { onSuccess: (value: object) => void }) =>
        callbacks.onSuccess({
          pairingCode: 'EXPI-RE01',
          expiresAt: new Date(Date.now() + 1_000).toISOString(),
        }),
    );
    render(<ConnectedChannels />);

    const telegram = screen.getByRole('group', { name: 'Telegram pairing' });
    fireEvent.click(within(telegram).getByRole('button', { name: 'Connect Telegram' }));
    expect(within(telegram).getByText('EXPI-RE01')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(1_001));

    expect(within(telegram).queryByText('EXPI-RE01')).not.toBeInTheDocument();
    expect(within(telegram).getByRole('status')).toHaveTextContent(
      'This pairing code expired. Create a new one.',
    );
    expect(within(telegram).getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('shows pairing-code errors with an accessible retry and handles blocked clipboard access', async () => {
    const writeText = jest.fn().mockRejectedValue(new Error('clipboard blocked'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockCreatePairingCode
      .mockImplementationOnce((_channel: string, callbacks: { onError: () => void }) =>
        callbacks.onError(),
      )
      .mockImplementationOnce(
        (_channel: string, callbacks: { onSuccess: (value: object) => void }) =>
          callbacks.onSuccess({
            pairingCode: 'RETR-Y001',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      );
    render(<ConnectedChannels />);

    const telegram = screen.getByRole('group', { name: 'Telegram pairing' });
    fireEvent.click(within(telegram).getByRole('button', { name: 'Connect Telegram' }));
    expect(within(telegram).getByRole('alert')).toHaveTextContent(
      'A pairing code could not be created. This channel may not be ready. Try again, or ask the person who manages this Viventium installation to check it.',
    );
    fireEvent.click(within(telegram).getByRole('button', { name: 'Try Telegram again' }));

    await act(async () => {
      fireEvent.click(within(telegram).getByRole('button', { name: 'Copy pairing code' }));
    });
    expect(within(telegram).getByRole('alert')).toHaveTextContent(
      'The code could not be copied. Select it and copy it manually.',
    );
  });

  it.each([
    ['approval_required', 'Ask a provider administrator to approve the app, then test again.'],
    [
      'connection_unavailable',
      'Check the local runtime and network, then test this channel again.',
    ],
    [
      'invalid_credentials',
      'Open Repair, replace the invalid or expired credentials, and test again.',
    ],
    [
      'missing_permission',
      'Add the required provider permission, reinstall the app if prompted, then test again.',
    ],
    [
      'public_https_required',
      'Configure a reachable public HTTPS address, then reconnect WhatsApp.',
    ],
    ['rate_limited', 'The provider is rate limiting checks. Wait a few minutes, then test again.'],
    [
      'webhook_verification_failed',
      'Confirm the callback and verify token in Meta, then retry verification.',
    ],
    ['transport_unavailable', 'Update or restart Viventium, then test the channel again.'],
    ['connection_test_failed', 'The provider test failed. Check the connection details and retry.'],
    [
      'webhook_verification_required',
      'Finish webhook verification at the provider, then test again.',
    ],
    [
      'credentials_unavailable',
      'Saved credentials could not be decrypted. Reconnect this channel.',
    ],
    [
      'worker_start_failed',
      'The channel worker could not start. Test it, then restart Viventium if needed.',
    ],
    [
      'worker_stop_failed',
      'The channel worker did not stop cleanly. Restart Viventium before reconnecting.',
    ],
    [
      'connection_conflict',
      'Another process is using this provider connection. Stop it, then test again.',
    ],
    [
      'webhook_in_use',
      'Telegram is using a webhook elsewhere. Remove it before enabling local polling.',
    ],
    [
      'operator_managed',
      'This Telegram connection is managed by Custom Settings Install. Test or restart it from the Viventium command line; do not connect the same bot here.',
    ],
  ])('maps the %s issue to actionable non-secret guidance', (issueCode, guidance) => {
    mockUseConnectedChannelsQuery.mockReturnValue({
      data: { channels: [{ channel: 'telegram', state: 'degraded', issueCode }] },
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
    });

    render(<ConnectedChannels />);

    expect(screen.getByRole('alert')).toHaveTextContent(guidance);
    expect(screen.getByRole('alert')).not.toHaveTextContent(issueCode);
  });

  it('offers a retry when channel state cannot be loaded', () => {
    mockUseConnectedChannelsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
    });

    render(<ConnectedChannels />);

    expect(screen.getByRole('alert')).toHaveTextContent('Connected channels could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});
