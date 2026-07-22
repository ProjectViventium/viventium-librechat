import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorTypes } from 'librechat-data-provider';
import { CONNECTED_ACCOUNTS_OPEN_EVENT } from '~/common/connectedAccounts';
import ErrorMessage from '../Error';

let mockConnectedAccountsEnabled = true;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { viventiumConnectedAccountsEnabled: mockConnectedAccountsEnabled },
  }),
}));

describe('message content Error', () => {
  beforeEach(() => {
    mockConnectedAccountsEnabled = true;
  });

  /* === VIVENTIUM START ===
   * Feature: Missing-key inline recovery regression coverage.
   * Purpose: Keep the typed missing-key error actionable from the chat surface.
   */
  it('offers one-click Connected Accounts recovery when a user API key is missing', () => {
    const openConnectedAccounts = jest.fn();
    window.addEventListener(CONNECTED_ACCOUNTS_OPEN_EVENT, openConnectedAccounts);

    try {
      render(<ErrorMessage text={JSON.stringify({ type: ErrorTypes.NO_USER_KEY })} />);

      expect(screen.getByText('com_error_no_user_key')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_connected_accounts' }));
      expect(openConnectedAccounts).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CONNECTED_ACCOUNTS_OPEN_EVENT, openConnectedAccounts);
    }
  });

  it('keeps missing-key guidance non-interactive when Connected Accounts is unavailable', () => {
    mockConnectedAccountsEnabled = false;

    render(<ErrorMessage text={JSON.stringify({ type: ErrorTypes.NO_USER_KEY })} />);

    expect(screen.getByText('com_error_no_user_key')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_connected_accounts' }),
    ).not.toBeInTheDocument();
  });
  /* === VIVENTIUM END === */

  it('renders connected-account reconnect guidance without generic wrapper text', () => {
    render(
      <ErrorMessage text="OpenAI connected account needs reconnect in Settings > Account > Connected Accounts. Reconnect OpenAI, then try again." />,
    );

    expect(
      screen.getByText(
        'OpenAI connected account needs reconnect in Settings > Account > Connected Accounts. Reconnect OpenAI, then try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
  });

  it('keeps the generic wrapper for non-actionable plain errors', () => {
    render(<ErrorMessage text="Unexpected provider failure" />);

    expect(
      screen.getByText(
        "Something went wrong. Here's the specific error message we encountered: Unexpected provider failure",
      ),
    ).toBeInTheDocument();
  });
});
