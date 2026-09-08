/**
 * === VIVENTIUM START ===
 * Feature: Truthful Connected Accounts regression coverage.
 * Purpose: Prove the stable API-key path stays available while legacy direct OAuth remains opt-in,
 * and prove a local credential deletion is never presented as provider-side revocation.
 * === VIVENTIUM END ===
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import translations from '~/locales/en/translation.json';
import ConnectedAccounts from './ConnectedAccounts';

const mockUseGetStartupConfig = jest.fn();
const mockUseGetEndpointsQuery = jest.fn();
const mockDisconnect = jest.fn();
const mockRefetch = jest.fn();
const mockRequestGet = jest.fn();
const mockRequestPut = jest.fn();
const mockShowToast = jest.fn();
let mockKeyLoading = false;
let mockKeyError = false;
let mockSavedEndpoints = new Set(['openAI', 'groq']);
const mockLocalize = (key: string, params?: Record<string, string>) => {
  const copy = translations[key as keyof typeof translations] ?? key;
  return Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    copy,
  );
};

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
    put: (...args: unknown[]) => mockRequestPut(...args),
  },
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: (endpoint: string) => ({
    data: { expiresAt: mockSavedEndpoints.has(endpoint) ? 'never' : null },
    isLoading: mockKeyLoading,
    isError: mockKeyError,
    isFetching: mockKeyLoading,
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
  useToastContext: () => ({ showToast: mockShowToast }),
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

jest.mock('~/hooks', () => ({ useLocalize: () => mockLocalize }));

jest.mock('~/common', () => ({
  NotificationSeverity: { SUCCESS: 'success', ERROR: 'error', INFO: 'info' },
}));

jest.mock('~/utils', () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(' '),
}));

describe('ConnectedAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKeyLoading = false;
    mockKeyError = false;
    mockSavedEndpoints = new Set(['openAI', 'groq']);
    mockRequestGet.mockResolvedValue({ policy: 'personal_preferred' });
    mockRequestPut.mockImplementation((_url: string, payload: unknown) => Promise.resolve(payload));
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        viventiumConnectedAccountsEnabled: true,
        viventiumExperimentalDirectSubscriptionAuth: false,
      },
    });
    mockUseGetEndpointsQuery.mockReturnValue({
      data: { openAI: { userProvide: true }, anthropic: { userProvide: true } },
    });
  });

  const section = (provider = 'OpenAI') =>
    screen.getByRole('region', { name: `${provider} account` });
  const openDetails = (provider = 'OpenAI') => {
    fireEvent.click(
      within(section(provider)).getByRole('button', {
        name: new RegExp(`^(Manage ${provider} account|${provider} details)$`),
      }),
    );
    return within(section(provider));
  };

  it('keeps one account action visible and opens the API key editor without OAuth', async () => {
    render(<ConnectedAccounts />);
    expect(within(section()).getByText('Account saved')).toBeInTheDocument();
    expect(within(section('Anthropic')).getByText('Not added')).toBeInTheDocument();
    expect(
      within(section()).getByRole('button', { name: 'Manage OpenAI account' }),
    ).toHaveTextContent('Manage');
    expect(within(section()).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(section()).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByText('Manage your AI accounts.')).not.toBeInTheDocument();
    expect(screen.queryByText('Sign in · Experimental')).not.toBeInTheDocument();
    fireEvent.click(within(section()).getByRole('button', { name: 'Manage OpenAI account' }));
    fireEvent.click(within(section()).getByRole('button', { name: 'Use OpenAI API key' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('openAI:openAI:disconnect');
    await waitFor(() => expect(mockRequestGet).toHaveBeenCalledTimes(2));
    expect(mockRequestGet).not.toHaveBeenCalledWith(expect.stringContaining('/start'));
  });

  it('opens custom API key forms with the existing endpoint type', async () => {
    render(<ConnectedAccounts />);
    openDetails('Groq');
    fireEvent.click(within(section('Groq')).getByRole('button', { name: 'Use Groq API key' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('groq:custom:disconnect');
    await waitFor(() => expect(mockRequestGet).toHaveBeenCalledTimes(2));
  });

  it('supports keyboard disclosure and keeps hidden controls out of the tab order', async () => {
    const user = userEvent.setup();
    render(<ConnectedAccounts />);
    const details = within(section()).getByRole('button', { name: 'Manage OpenAI account' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(within(section()).queryByRole('checkbox')).not.toBeInTheDocument();
    details.focus();
    await user.keyboard('{Enter}');
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(details.getAttribute('aria-controls')!)).toBeInTheDocument();
    const preference = await within(section()).findByRole('checkbox', {
      name: 'Use only my account',
    });
    await user.tab();
    expect(within(section()).getByRole('button', { name: 'Use OpenAI API key' })).toHaveFocus();
    await user.tab();
    expect(preference).toHaveFocus();
    details.focus();
    await user.keyboard(' ');
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(within(section()).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('removes only the saved account and refreshes its existing owner', async () => {
    mockDisconnect.mockImplementationOnce(
      (_variables: unknown, callbacks: { onSuccess: () => Promise<void> }) =>
        void callbacks.onSuccess(),
    );
    render(<ConnectedAccounts />);
    const account = openDetails('Groq');
    const remove = account.getByRole('button', { name: 'Remove' });
    expect(remove).toHaveAccessibleDescription(
      'Removes it from Viventium. Provider access stays unchanged.',
    );
    fireEvent.click(remove);
    await waitFor(() => expect(mockRefetch).toHaveBeenCalledWith('groq'));
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('places opted-in experimental sign-in behind details and beside its limitation', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        viventiumConnectedAccountsEnabled: true,
        viventiumExperimentalDirectSubscriptionAuth: true,
      },
    });
    render(<ConnectedAccounts />);
    expect(
      screen.queryByRole('button', { name: 'Sign in · Experimental' }),
    ).not.toBeInTheDocument();
    const account = openDetails();
    expect(
      account.getByRole('button', { name: 'Sign in · Experimental' }),
    ).toHaveAccessibleDescription(
      'Subscription sign-in is experimental and is not an official provider integration.',
    );
    expect(
      within(section('Anthropic')).queryByText(
        'Subscription sign-in is experimental and is not an official provider integration.',
      ),
    ).not.toBeInTheDocument();
    await account.findByRole('checkbox');
  });

  it('persists the exclusive account preference and never invents shared access while it loads', async () => {
    let resolvePolicy: (value: { policy: string }) => void = () => undefined;
    mockRequestGet.mockReturnValue(
      new Promise((resolve) => {
        resolvePolicy = resolve;
      }),
    );
    mockUseGetEndpointsQuery.mockReturnValue({
      data: { openAI: { userProvide: false }, anthropic: { userProvide: false } },
    });
    mockSavedEndpoints.clear();
    render(<ConnectedAccounts />);
    const account = openDetails('Anthropic');
    expect(account.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(account.queryByText('Using shared access')).not.toBeInTheDocument();
    resolvePolicy({ policy: 'personal_preferred' });
    const preference = await account.findByRole('checkbox', { name: 'Use only my account' });
    expect(account.getByText('Using shared access')).toBeInTheDocument();
    fireEvent.click(preference);
    await waitFor(() =>
      expect(mockRequestPut).toHaveBeenCalledWith('/api/connected-accounts/anthropic/policy', {
        policy: 'personal_required',
      }),
    );
    await waitFor(() => expect(preference).toBeChecked());
    expect(account.queryByText('Using shared access')).not.toBeInTheDocument();
  });

  it('retains a saved preference after an update fails', async () => {
    mockRequestGet.mockResolvedValue({ policy: 'personal_required' });
    mockRequestPut.mockRejectedValue(new Error('save unavailable'));
    render(<ConnectedAccounts />);
    const preference = await openDetails().findByRole('checkbox', { name: 'Use only my account' });
    expect(preference).toBeChecked();
    fireEvent.click(preference);
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' })),
    );
    expect(preference).toBeChecked();
    expect(preference).toBeEnabled();
  });

  it('keeps preference controls when account setup is managed elsewhere', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { viventiumConnectedAccountsEnabled: false, viventiumCredentialPolicyEnabled: true },
    });
    render(<ConnectedAccounts />);
    expect(
      await openDetails().findByRole('checkbox', { name: 'Use only my account' }),
    ).toBeEnabled();
    const anthropic = openDetails('Anthropic');
    expect(await anthropic.findByRole('checkbox', { name: 'Use only my account' })).toBeDisabled();
    expect(anthropic.getByText('Add your account to use this setting.')).toBeInTheDocument();
    expect(
      within(section()).queryByRole('button', { name: 'Manage OpenAI account' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Groq account' })).not.toBeInTheDocument();
  });

  it('reports unavailable preferences even when details are closed', async () => {
    mockRequestGet.mockRejectedValue(new Error('policy unavailable'));
    render(<ConnectedAccounts />);
    expect(await within(section()).findByRole('alert')).toHaveTextContent(
      'Could not load your account preference.',
    );
    expect(openDetails().queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('does not show a saved or absent account while its status is loading', async () => {
    mockKeyLoading = true;
    render(<ConnectedAccounts />);
    expect(within(section()).getByRole('status')).toHaveTextContent('Checking account…');
    expect(within(section()).getByRole('button', { name: 'Manage OpenAI account' })).toBeDisabled();
    expect(within(section()).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    await waitFor(() => expect(mockRequestGet).toHaveBeenCalledTimes(2));
  });

  it('offers a real retry after account lookup fails without claiming saved access', async () => {
    mockKeyError = true;
    render(<ConnectedAccounts />);
    expect(within(section()).getByRole('status')).toHaveTextContent('Could not load account');
    fireEvent.click(within(section()).getByRole('button', { name: 'Retry OpenAI account' }));
    expect(mockRefetch).toHaveBeenCalledWith('openAI');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(mockRequestGet).toHaveBeenCalledTimes(2));
  });
});
