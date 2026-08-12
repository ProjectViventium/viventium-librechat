import { act, fireEvent, render, screen } from '@testing-library/react';
import axios from 'axios';
import { request } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import WhoopConnection from '../WhoopConnection';

jest.mock('axios', () => ({
  post: jest.fn(),
  interceptors: { response: { use: jest.fn() } },
}));
jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: jest.fn(() => ''),
  request: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  useToastContext: jest.fn(),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const setupStatus = {
  schemaVersion: 1,
  provider: 'whoop',
  state: 'setup_required',
  clientConfigured: false,
  authorized: false,
  authorizationRecoveryRequired: false,
  requestedScopes: [],
  grantedScopes: [],
  coverage: { api: {}, export: {} },
  latestApiRun: null,
  latestExportRun: null,
  manualEvidence: { itemCount: 0, latestAt: null },
  schedule: { state: 'not_configured', configured: false, loaded: false },
  onboarding: null,
  limitations: {
    stressMonitor: 'manual_evidence_only',
    apiExportBoundary: 'official_sources_only',
  },
};

const connectedStatus = {
  ...setupStatus,
  state: 'connected',
  clientConfigured: true,
  authorized: true,
  grantedScopes: [
    'read:cycles',
    'read:recovery',
    'read:sleep',
    'read:workout',
    'read:profile',
    'read:body_measurement',
    'offline',
  ],
  coverage: {
    api: {
      cycles: { status: 'complete', items: 15 },
      recovery: { status: 'complete', items: 14 },
      sleep: { status: 'complete', items: 14 },
      workout: { status: 'complete', items: 6 },
      profile: { status: 'complete', items: 1 },
      body_measurement: { status: 'complete', items: 1 },
    },
    export: { journal_entries: { status: 'available_by_import' } },
  },
  latestApiRun: {
    status: 'complete',
    finishedAt: '2026-08-10T12:00:00Z',
    itemCount: 51,
  },
  manualEvidence: { itemCount: 2, latestAt: '2026-08-10T12:00:00Z' },
  schedule: { state: 'active', configured: true, loaded: true },
};

describe('WHOOP connection card', () => {
  const mockGet = request.get as jest.MockedFunction<typeof request.get>;
  const mockPost = request.post as jest.MockedFunction<typeof request.post>;
  const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
  const showToast = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useToastContext as jest.Mock).mockReturnValue({ showToast });
  });

  test('uses one save-and-connect action, all documented scopes, and manual callback recovery', async () => {
    mockGet.mockResolvedValue(setupStatus as never);
    mockPost
      .mockResolvedValueOnce({ status: 'configured' } as never)
      .mockResolvedValueOnce({
        status: 'authorization_pending',
        authorizationUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth?state=12345678',
      } as never)
      .mockResolvedValueOnce({ status: 'accepted' } as never);
    const popup = { location: { href: '' }, close: jest.fn() } as unknown as Window;
    const openSpy = jest.spyOn(window, 'open').mockReturnValue(popup);

    render(<WhoopConnection />);
    await screen.findByText('com_ui_whoop_setup_title');
    fireEvent.change(screen.getByLabelText('com_ui_whoop_client_id'), {
      target: { value: 'public-client' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_whoop_client_secret'), {
      target: { value: 'private-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_whoop_save_connect' }));

    await act(async () => undefined);
    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/viventium/health/whoop/configure', {
      clientId: 'public-client',
      clientSecret: 'private-secret',
      redirectUri: 'viventium://oauth/whoop',
    });
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/viventium/health/whoop/authorize', {});
    expect(popup.location.href).toContain('api.prod.whoop.com/oauth/oauth2/auth');
    expect(await screen.findByLabelText('com_ui_whoop_callback_url')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('com_ui_whoop_callback_url'), {
      target: { value: 'viventium://oauth/whoop?code=private&state=12345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_whoop_finish_connection' }));
    await act(async () => undefined);
    expect(mockPost).toHaveBeenNthCalledWith(3, '/api/viventium/health/whoop/complete', {
      callbackUrl: 'viventium://oauth/whoop?code=private&state=12345678',
    });
    openSpy.mockRestore();
  });

  test('shows readable full API coverage, ongoing correction status, and honest gaps', async () => {
    mockGet.mockResolvedValue(connectedStatus as never);

    render(<WhoopConnection />);

    expect(await screen.findByText('51')).toBeInTheDocument();
    for (const key of [
      'com_ui_whoop_cycles',
      'com_ui_whoop_recovery',
      'com_ui_whoop_sleep',
      'com_ui_whoop_workouts',
      'com_ui_whoop_profile',
      'com_ui_whoop_body',
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument();
    }
    expect(screen.getByText('com_ui_whoop_daily_active')).toBeInTheDocument();
    expect(screen.getByText('com_ui_whoop_journal_export_gap')).toBeInTheDocument();
    expect(screen.getByText('com_ui_whoop_stress_manual_gap')).toBeInTheDocument();
    expect(screen.getByText('com_ui_whoop_manual_evidence_count')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  test('restores callback recovery after refresh and does not offer a duplicate connect', async () => {
    mockGet.mockResolvedValue({
      ...setupStatus,
      state: 'authorization_pending',
      clientConfigured: true,
    } as never);

    render(<WhoopConnection />);

    expect(await screen.findByLabelText('com_ui_whoop_callback_url')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_whoop_connect' })).not.toBeInTheDocument();
  });

  test('explains degraded history and keeps official recovery paths available', async () => {
    mockGet.mockResolvedValue({
      ...connectedStatus,
      state: 'degraded',
      onboarding: {
        phase: 'history_import',
        status: 'failed',
        errorCode: 'history_import_failed',
      },
    } as never);

    render(<WhoopConnection />);

    expect(await screen.findByText('com_ui_whoop_error_history_import_failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_whoop_import_export' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_whoop_connect' })).not.toBeInTheDocument();
  });

  test.each(['authorization_failed', 'authorization_refresh_failed'])(
    'offers a fresh one-click authorization for provider recovery state %s',
    async (recoveryStatus) => {
      mockGet.mockResolvedValue({
        ...connectedStatus,
        state: 'degraded',
        authorizationRecoveryRequired: true,
        onboarding: null,
        coverage: {
          ...connectedStatus.coverage,
          api: Object.fromEntries(
            Object.keys(connectedStatus.coverage.api).map((resource) => [
              resource,
              { status: recoveryStatus, items: 0 },
            ]),
          ),
        },
        latestApiRun: {
          status: 'failed',
          finishedAt: '2026-08-11T10:00:00Z',
          itemCount: 0,
        },
      } as never);

      render(<WhoopConnection />);

      expect(
        await screen.findByText('com_ui_whoop_error_authorization_failed'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_whoop_connect' })).toBeInTheDocument();
    },
  );

  test('keeps one-click reconnect available when a migrated grant has no API run yet', async () => {
    mockGet.mockResolvedValue({
      ...connectedStatus,
      state: 'connected_no_data',
      latestApiRun: null,
    } as never);

    render(<WhoopConnection />);

    expect(await screen.findByText('com_ui_whoop_connected_import_pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_whoop_connect' })).toBeInTheDocument();
  });

  test('uploads exact screenshot evidence without exposing its file name', async () => {
    mockGet.mockResolvedValue(connectedStatus as never);
    mockAxiosPost.mockResolvedValue({ data: { status: 'complete', itemCount: 1 } });
    const { container } = render(<WhoopConnection />);
    await screen.findByText('51');
    const image = new File(['\x89PNG\r\n\x1a\nprivate'], 'stress-private-name.png', {
      type: 'image/png',
    });
    const input = container.querySelector('input[accept="image/png,image/jpeg"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, { target: { files: [image] } });
    await act(async () => undefined);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/api/viventium/health/whoop/evidence',
      image,
      expect.objectContaining({ headers: { 'Content-Type': 'image/png' } }),
    );
    expect(screen.queryByText('stress-private-name.png')).not.toBeInTheDocument();
  });

  test('uploads the exact ZIP body and refreshes status without exposing the file name', async () => {
    mockGet.mockResolvedValue(connectedStatus as never);
    mockAxiosPost.mockResolvedValue({ data: { status: 'complete', fileCount: 4 } });
    const { container } = render(<WhoopConnection />);
    await screen.findByText('51');
    const file = new File(['PK\u0003\u0004private-export'], 'private-person-name.zip', {
      type: 'application/zip',
    });
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await act(async () => undefined);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/api/viventium/health/whoop/import',
      file,
      expect.objectContaining({ headers: { 'Content-Type': 'application/zip' } }),
    );
    expect(screen.queryByText('private-person-name.zip')).not.toBeInTheDocument();
  });
});
