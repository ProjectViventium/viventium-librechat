/**
 * === VIVENTIUM START ===
 * Feature: Truthful Connected Accounts regression coverage.
 * Purpose: Prove the stable API-key path stays available while legacy direct OAuth remains opt-in,
 * and prove a local credential deletion is never presented as provider-side revocation.
 * === VIVENTIUM END ===
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ConnectedAccounts from './ConnectedAccounts';

const mockUseGetStartupConfig = jest.fn();
const mockUseGetEndpointsQuery = jest.fn();
const mockDisconnect = jest.fn();
const mockRefetch = jest.fn();
const mockRequestGet = jest.fn();

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    openAI: 'openAI',
    anthropic: 'anthropic',
    azureOpenAI: 'azureOpenAI',
    custom: 'custom',
  },
  apiBaseUrl: () => '',
  request: {
    get: (...args: unknown[]) => mockRequestGet(...args),
    post: jest.fn(),
  },
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: (endpoint: string) => ({
    data: { expiresAt: endpoint === 'openAI' || endpoint === 'groq' ? 'never' : null },
    isLoading: false,
    refetch: () => mockRefetch(endpoint),
  }),
  useRevokeUserKeyMutation: () => ({
    isLoading: false,
    mutate: mockDisconnect,
  }),
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Spinner: () => <span data-testid="spinner" />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
  useGetEndpointsQuery: () => mockUseGetEndpointsQuery(),
}));

jest.mock('~/components/Input/SetKeyDialog', () => ({
  SetKeyDialog: ({
    endpoint,
    endpointType,
    open,
    removalMode,
  }: {
    endpoint: string;
    endpointType?: string;
    open: boolean;
    removalMode: string;
  }) =>
    open ? (
      <div role="dialog">{`${endpoint}:${endpointType ?? endpoint}:${removalMode}`}</div>
    ) : null,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, string>) => {
    if (key === 'com_ui_connected_accounts_use_provider_api_key') {
      return `Use ${params?.provider} API key`;
    }
    const copy: Record<string, string> = {
      com_ui_openai: 'OpenAI',
      com_ui_anthropic: 'Anthropic',
      com_ui_groq: 'Groq',
      com_ui_xai: 'Grok (xAI)',
      com_ui_connected_accounts: 'Connected Accounts',
      com_ui_connected_accounts_description: 'Add your own API key.',
      com_ui_connected_accounts_disconnect: 'Disconnect',
      com_ui_connected_accounts_disconnect_local_only:
        'Disconnect removes this credential from Viventium only. It does not revoke provider access or API keys.',
      com_ui_connected_accounts_experimental: 'Experimental account connection',
      com_ui_connected_accounts_experimental_description: 'Optional legacy subscription sign-in.',
      com_ui_connected_accounts_local_credential_saved: 'Local credential saved',
      com_ui_connected_accounts_no_local_credential: 'No local credential saved',
      com_ui_connected_account_source_user: 'A local credential is saved for this provider.',
      com_ui_connected_account_source_none: 'No local credential is configured.',
    };
    return copy[key] ?? key;
  },
}));

jest.mock('~/common', () => ({
  NotificationSeverity: { SUCCESS: 'success', ERROR: 'error', INFO: 'info' },
}));

jest.mock('~/utils', () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(' '),
}));

describe('ConnectedAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseGetEndpointsQuery.mockReturnValue({
      data: {
        openAI: { userProvide: true },
        anthropic: { userProvide: true },
      },
    });
  });

  it('uses API keys by default and describes Disconnect as local-only removal', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        viventiumConnectedAccountsEnabled: true,
        viventiumExperimentalDirectSubscriptionAuth: false,
      },
    });

    render(<ConnectedAccounts />);

    expect(screen.getByRole('button', { name: 'Use OpenAI API key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Anthropic API key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Groq API key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Grok (xAI) API key' })).toBeInTheDocument();
    expect(screen.queryByText('Experimental account connection')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(
      screen.getAllByText(
        'Disconnect removes this credential from Viventium only. It does not revoke provider access or API keys.',
      ),
    ).toHaveLength(2);

    const openAISection = screen.getByRole('region', { name: 'OpenAI account' });
    fireEvent.click(within(openAISection).getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).toHaveBeenCalledTimes(1);

    fireEvent.click(within(openAISection).getByRole('button', { name: 'Use OpenAI API key' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('openAI:openAI:disconnect');
    expect(mockRequestGet).not.toHaveBeenCalled();
  });

  it('opens custom endpoint key forms for Groq and Grok without experimental OAuth', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        viventiumConnectedAccountsEnabled: true,
        viventiumExperimentalDirectSubscriptionAuth: false,
      },
    });

    render(<ConnectedAccounts />);

    const groqSection = screen.getByRole('region', { name: 'Groq account' });
    fireEvent.click(within(groqSection).getByRole('button', { name: 'Use Groq API key' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('groq:custom:disconnect');
  });

  it('refetches custom credential state after a successful local disconnect', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        viventiumConnectedAccountsEnabled: true,
        viventiumExperimentalDirectSubscriptionAuth: false,
      },
    });
    mockDisconnect.mockImplementationOnce(
      (_variables: unknown, callbacks: { onSuccess: () => Promise<void> }) => {
        void callbacks.onSuccess();
      },
    );

    render(<ConnectedAccounts />);

    const groqSection = screen.getByRole('region', { name: 'Groq account' });
    fireEvent.click(within(groqSection).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mockRefetch).toHaveBeenCalledWith('groq'));
  });

  it('labels and exposes legacy direct OAuth only after explicit opt-in', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        viventiumConnectedAccountsEnabled: true,
        viventiumExperimentalDirectSubscriptionAuth: true,
      },
    });

    render(<ConnectedAccounts />);

    expect(screen.getAllByText('Experimental account connection')).toHaveLength(3);
    expect(screen.getByText('Optional legacy subscription sign-in.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use OpenAI API key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Anthropic API key' })).toBeInTheDocument();
  });
});
