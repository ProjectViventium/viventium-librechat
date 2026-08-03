import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import DeleteButton from '../DeleteButton';

const mockReset = jest.fn();
const mockSetCurrentAgentId = jest.fn();
const mockSetConversation = jest.fn();
const mockMutate = jest.fn();
let mutationOptions: Record<string, (...args: any[]) => void>;

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({ reset: mockReset }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => 'conversation-agent',
  useSetRecoilState: () => mockSetConversation,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/common', () => ({
  isEphemeralAgent: () => false,
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  getDefaultAgentFormValues: jest.fn(() => ({})),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationByIndex: jest.fn(),
    conversationAgentIdByIndex: jest.fn(),
  },
}));

jest.mock('~/data-provider', () => ({
  useDeleteAgentMutation: (options: Record<string, (...args: any[]) => void>) => {
    mutationOptions = options;
    return { mutate: mockMutate };
  },
}));

jest.mock('@librechat/client', () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  TrashIcon: () => <span>trash</span>,
  OGDialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OGDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OGDialogTemplate: ({ selection }) => (
    <button type="button" onClick={selection.selectHandler}>
      {selection.selectText}
    </button>
  ),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

describe('DeleteButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clears the active query before delete and restores it when deletion fails', () => {
    render(
      <DeleteButton
        agent_id="agent-to-delete"
        setCurrentAgentId={mockSetCurrentAgentId}
        createMutation={{ data: undefined } as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));
    expect(mockMutate).toHaveBeenCalledWith({ agent_id: 'agent-to-delete' });

    mutationOptions.onMutate({ agent_id: 'agent-to-delete' });
    expect(mockSetCurrentAgentId).toHaveBeenCalledWith(undefined);

    mutationOptions.onError(new Error('synthetic delete failure'));
    const restoreSelection = mockSetCurrentAgentId.mock.calls.at(-1)?.[0];
    expect(restoreSelection(undefined)).toBe('agent-to-delete');
    expect(restoreSelection('newer-user-selection')).toBe('newer-user-selection');
  });

  it('selects the replacement when deleting the agent used by the conversation', () => {
    render(
      <DeleteButton
        agent_id="conversation-agent"
        setCurrentAgentId={mockSetCurrentAgentId}
        createMutation={{ data: undefined } as any}
      />,
    );

    mutationOptions.onSuccess(undefined, { agent_id: 'conversation-agent' }, [
      { id: 'replacement-agent' },
    ]);

    expect(mockSetConversation).toHaveBeenCalled();
    expect(mockSetCurrentAgentId).toHaveBeenLastCalledWith('replacement-agent');
  });
});
