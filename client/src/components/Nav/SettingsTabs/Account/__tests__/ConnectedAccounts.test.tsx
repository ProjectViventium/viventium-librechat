import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { EModelEndpoint, request } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { useRevokeUserKeyMutation, useUserKeyQuery } from 'librechat-data-provider/react-query';
import ConnectedAccounts from '../ConnectedAccounts';

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    anthropic: 'anthropic',
    azureOpenAI: 'azureOpenAI',
    custom: 'custom',
    openAI: 'openAI',
  },
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
  useGetStartupConfig: () => ({
    data: {
      viventiumConnectedAccountsEnabled: true,
      viventiumExperimentalDirectSubscriptionAuth: true,
    },
  }),
}));

jest.mock('~/components/Input/SetKeyDialog', () => () => null);
jest.mock('~/hooks', () => {
  const localize = (key: string) => key;
  return { useLocalize: () => localize };
});
jest.mock('~/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));

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
    let unmount = () => undefined;
    await act(async () => {
      ({ unmount } = render(<ConnectedAccounts />));
    });
    const openAISection = screen.getByRole('region', { name: 'com_ui_openai account' });
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
});
