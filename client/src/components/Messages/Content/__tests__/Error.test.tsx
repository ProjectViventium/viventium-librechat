import React from 'react';
import { render, screen } from '@testing-library/react';
import ErrorMessage from '../Error';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('message content Error', () => {
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
