/**
 * === VIVENTIUM START ===
 * Feature: Truthful, cancellable first-run API-key setup.
 * Purpose: Keep the selected retention policy and explanatory copy aligned, and prove cancel
 * never saves or retains a credential draft.
 * === VIVENTIUM END ===
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import SetKeyDialog from './SetKeyDialog';

const mockSaveUserKey = jest.fn();
const mockShowToast = jest.fn();

jest.mock('librechat-data-provider/react-query', () => ({
  useRevokeUserKeyMutation: () => ({ isLoading: false, mutate: jest.fn() }),
  useRevokeAllUserKeysMutation: () => ({ isLoading: false, mutate: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Spinner: () => <span aria-label="loading" />,
  OGDialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div>
        <button type="button" aria-label="Close dialog" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null,
  OGDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  OGDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  OGDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTrigger: ({ children }: { children: React.ReactNode }) => children,
  Dropdown: ({ label, value }: { label: string; value: string }) => (
    <>
      <button type="button" role="combobox" aria-controls="expiry-options" aria-expanded="false">
        {label}
        {value}
      </button>
      <div id="expiry-options" role="listbox" hidden />
    </>
  ),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useUserKey: () => ({
    getExpiry: () => 'never',
    saveUserKey: (...args: unknown[]) => mockSaveUserKey(...args),
  }),
  useLocalize: () => (key: string) => {
    const copy: Record<string, string> = {
      com_endpoint_config_key_for: 'Set API Key for',
      com_endpoint_config_key_encryption: 'Your key will be encrypted and deleted at',
      com_endpoint_config_key_never_expires: 'Your key will never expire',
      com_ui_submit: 'Submit',
      com_ui_revoke: 'Revoke',
      com_ui_cancel: 'Cancel',
    };
    return copy[key] ?? key;
  },
}));

jest.mock('~/common', () => ({
  NotificationSeverity: { SUCCESS: 'success', ERROR: 'error' },
}));

jest.mock('~/utils', () => ({ logger: { error: jest.fn() } }));

jest.mock('./OpenAIConfig', () => ({
  __esModule: true,
  default: ({ userKey, setUserKey }: { userKey: string; setUserKey: (value: string) => void }) => (
    <input
      aria-label="API key"
      value={userKey}
      onChange={(event) => setUserKey(event.target.value)}
    />
  ),
}));

describe('SetKeyDialog first-run lifecycle truth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('describes the selected 12-hour retention instead of the current saved-key state', () => {
    render(<SetKeyDialog open onOpenChange={jest.fn()} endpoint={EModelEndpoint.openAI} />);

    expect(screen.getByRole('combobox')).toHaveTextContent('Expires in 12 hours');
    expect(screen.getByText(/Your key will be encrypted and deleted at/)).toBeInTheDocument();
    expect(screen.queryByText('Your key will never expire')).not.toBeInTheDocument();
  });

  it('clears an unsaved key draft when cancelled and never calls storage', () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(
      <SetKeyDialog open onOpenChange={onOpenChange} endpoint={EModelEndpoint.openAI} />,
    );

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSaveUserKey).not.toHaveBeenCalled();

    rerender(
      <SetKeyDialog open={false} onOpenChange={onOpenChange} endpoint={EModelEndpoint.openAI} />,
    );
    rerender(<SetKeyDialog open onOpenChange={onOpenChange} endpoint={EModelEndpoint.openAI} />);
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });

  it('clears an unsaved key draft when the parent dismisses the controlled dialog', () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(
      <SetKeyDialog open onOpenChange={onOpenChange} endpoint={EModelEndpoint.openAI} />,
    );

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-secret' } });
    rerender(
      <SetKeyDialog open={false} onOpenChange={onOpenChange} endpoint={EModelEndpoint.openAI} />,
    );
    rerender(<SetKeyDialog open onOpenChange={onOpenChange} endpoint={EModelEndpoint.openAI} />);

    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(mockSaveUserKey).not.toHaveBeenCalled();
  });
});
