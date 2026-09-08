import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import MemoryCreateDialog from '../MemoryCreateDialog';

const mockCreateMemory = jest.fn();
const mockShowToast = jest.fn();

jest.mock('~/data-provider', () => ({
  useCreateMemoryMutation: () => ({ mutate: mockCreateMemory, isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useLocalize: () => (key: string, values?: Record<number, string>) => {
    const translations: Record<string, string> = {
      com_ui_create_memory: 'Create Memory',
      com_ui_key: 'Key',
      com_ui_value: 'Value',
      com_ui_enter_key: 'Enter key',
      com_ui_enter_value: 'Enter value',
      com_ui_memory_key_hint: 'Use lowercase letters and underscores only',
      com_ui_memory_key_not_allowed: `Choose an allowed key: ${values?.[0] ?? ''}`,
      com_ui_create: 'Create',
    };
    return translations[key] ?? key;
  },
}));

jest.mock('@librechat/client', () => ({
  OGDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTemplate: ({
    title,
    main,
    buttons,
  }: {
    title: string;
    main: React.ReactNode;
    buttons: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {main}
      {buttons}
    </div>
  ),
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Label: (props: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Spinner: () => <span data-testid="spinner" />,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

describe('MemoryCreateDialog governed keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('blocks an unconfigured key before the request and accepts a configured key', () => {
    render(
      <MemoryCreateDialog open={true} onOpenChange={jest.fn()} validKeys={['preferences', 'world']}>
        <span />
      </MemoryCreateDialog>,
    );

    const keyInput = screen.getByLabelText('Key');
    const valueInput = screen.getByLabelText('Value');
    const createButton = screen.getByRole('button', { name: 'Create Memory' });

    fireEvent.change(keyInput, { target: { value: 'qa_constellation' } });
    fireEvent.change(valueInput, { target: { value: 'synthetic value' } });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose an allowed key: preferences, world',
    );
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(mockCreateMemory).not.toHaveBeenCalled();

    fireEvent.change(keyInput, { target: { value: 'preferences' } });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);
    expect(mockCreateMemory).toHaveBeenCalledWith({
      key: 'preferences',
      value: 'synthetic value',
    });
  });
});
