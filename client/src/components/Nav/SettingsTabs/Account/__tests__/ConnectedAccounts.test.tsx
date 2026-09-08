import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { EModelEndpoint, request } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { useRevokeUserKeyMutation, useUserKeyQuery } from 'librechat-data-provider/react-query';
import ConnectedAccounts, { connectedAccountPlatformFallbackAvailable } from '../ConnectedAccounts';
import Account from '../Account';
import { CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT } from '~/common/connectedAccounts';

let mockStartupConfig = {
  viventiumConnectedAccountsEnabled: true,
  viventiumExperimentalDirectSubscriptionAuth: true,
  viventiumParallelWorkAvailable: false,
};

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    anthropic: 'anthropic',
    azureOpenAI: 'azureOpenAI',
    custom: 'custom',
    openAI: 'openAI',
  },
  SystemRoles: { ADMIN: 'ADMIN' },
  apiBaseUrl: jest.fn(() => ''),
  request: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useRevokeUserKeyMutation: jest.fn(),
  useUserKeyQuery: jest.fn(),
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Spinner: () => <span data-testid="spinner" />,
  useToastContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/components/Input/SetKeyDialog', () => () => null);
jest.mock('~/hooks', () => {
  const localize = (key: string, params?: { provider: string }) =>
    key === 'com_ui_connected_accounts_provider_region' ? `${params?.provider} account` : key;
  return {
    useLocalize: () => localize,
    useAuthContext: () => ({ user: { role: 'USER', provider: 'external' } }),
  };
});
jest.mock('~/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));
jest.mock('../WhoopConnection', () => () => null);
jest.mock('../DisplayUsernameMessages', () => () => null);
jest.mock('../DeleteAccount', () => () => null);
jest.mock('../Avatar', () => () => null);
jest.mock('../TwoFactorAuthentication', () => () => null);
jest.mock('../BackupCodesItem', () => () => null);
jest.mock('../ParallelWork', () => () => <div data-testid="parallel-work-account" />);

describe('ConnectedAccounts OAuth polling', () => {
  const openAIRefetch = jest.fn();
  const showToast = jest.fn();
  const mockRequestGet = request.get as jest.MockedFunction<typeof request.get>;
  const mockUseUserKeyQuery = useUserKeyQuery as jest.MockedFunction<typeof useUserKeyQuery>;
  const mockUseRevokeUserKeyMutation = useRevokeUserKeyMutation as jest.MockedFunction<
    typeof useRevokeUserKeyMutation
  >;
  const mockUseToastContext = useToastContext as jest.MockedFunction<typeof useToastContext>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockUseToastContext.mockReturnValue({ showToast } as never);
    mockUseRevokeUserKeyMutation.mockReturnValue({ isLoading: false, mutate: jest.fn() } as never);
    mockUseUserKeyQuery.mockImplementation(
      (endpoint) =>
        ({
          data: endpoint === EModelEndpoint.openAI ? { expiresAt: 'never' } : {},
          isLoading: false,
          refetch: endpoint === EModelEndpoint.openAI ? openAIRefetch : jest.fn(),
        }) as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not treat a key saved before this attempt as OAuth completion', async () => {
    let attemptStatus = 'pending';
    mockRequestGet.mockImplementation((url) => {
      if (String(url).endsWith('/policy')) {
        return Promise.resolve({ policy: 'personal_preferred' }) as never;
      }
      if (String(url).endsWith('/start')) {
        return Promise.resolve({
          attemptId: 'attempt-current',
          authUrl: 'https://auth.openai.com/oauth/authorize?state=current-state',
          flowMode: 'popup_callback',
        }) as never;
      }
      return Promise.resolve({ attemptId: 'attempt-current', status: attemptStatus }) as never;
    });

    const popup = {
      closed: false,
      close: jest.fn(),
      location: { href: '' },
    } as unknown as Window;
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => popup);
    let unmount: () => void = () => undefined;
    await act(async () => {
      ({ unmount } = render(<ConnectedAccounts />));
    });
    const openAISection = screen.getByRole('region', { name: 'com_ui_openai account' });
    fireEvent.click(
      within(openAISection).getByRole('button', {
        name: 'com_ui_connected_accounts_manage_provider',
      }),
    );
    const connectButton = within(openAISection).getByRole('button', {
      name: 'com_ui_connected_accounts_experimental',
    });

    await act(async () => {
      fireEvent.click(connectButton);
    });
    await act(async () => {
      jest.advanceTimersByTime(1_200);
    });

    expect(mockRequestGet).toHaveBeenCalledWith(
      '/api/connected-accounts/openai/status?attemptId=attempt-current',
    );
    expect(openAIRefetch).not.toHaveBeenCalled();
    expect(popup.close).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();

    attemptStatus = 'completed';
    await act(async () => {
      jest.advanceTimersByTime(1_200);
    });

    expect(openAIRefetch).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);

    unmount();
    openSpy.mockRestore();
  });

  it('keeps a pending manual sign-in usable while account details are collapsed', async () => {
    mockRequestGet.mockResolvedValue({ policy: 'personal_preferred' } as never);
    (request.post as jest.Mock).mockResolvedValue({});
    await act(async () => {
      render(<ConnectedAccounts />);
    });
    const anthropic = screen.getByRole('region', { name: 'com_ui_anthropic account' });
    const details = within(anthropic).getByRole('button', {
      name: 'com_ui_connected_accounts_provider_details',
    });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CONNECTED_ACCOUNTS_MANUAL_FLOW_EVENT, {
          detail: { provider: 'anthropic', state: 'synthetic-flow-state' },
        }),
      );
    });
    const code = within(anthropic).getByRole('textbox', {
      name: 'com_ui_connected_account_manual_instructions',
    });
    const submit = within(anthropic).getByRole('button', { name: 'com_ui_submit' });
    expect(submit).toBeDisabled();
    fireEvent.change(code, { target: { value: 'synthetic-callback-code' } });
    expect(submit).toBeEnabled();
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(request.post).toHaveBeenCalledWith('/api/connected-accounts/anthropic/complete', {
      callbackInput: 'synthetic-callback-code',
      state: 'synthetic-flow-state',
    });
    expect(within(anthropic).queryByRole('textbox')).not.toBeInTheDocument();
    expect(details).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ConnectedAccounts provider source truth', () => {
  it('does not advertise a platform fallback when connected-account auth is required', () => {
    expect(connectedAccountPlatformFallbackAvailable(true, true)).toBe(false);
    expect(connectedAccountPlatformFallbackAvailable(true, false)).toBe(true);
    expect(connectedAccountPlatformFallbackAvailable(false, false)).toBe(false);
  });
});

describe('Account Parallel work wiring', () => {
  beforeEach(() => {
    mockStartupConfig = {
      viventiumConnectedAccountsEnabled: false,
      viventiumExperimentalDirectSubscriptionAuth: false,
      viventiumParallelWorkAvailable: true,
    };
  });

  it.each([true, false])(
    'mounts the owner control when public release availability is %p',
    (available) => {
      mockStartupConfig.viventiumParallelWorkAvailable = available;
      render(<Account />);

      expect(screen.getByTestId('parallel-work-account')).toBeInTheDocument();
    },
  );
});
