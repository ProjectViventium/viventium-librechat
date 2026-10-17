/* === VIVENTIUM START === Saved user files survive an empty-caption edit. === */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import EditMessage from '../EditMessage';

const mockAsk = jest.fn();
const mockUpdate = jest.fn();
let mockMessage: TMessage;
jest.mock('~/Providers', () => ({
  useMessagesConversation: () => ({ conversation: { conversationId: 'conversation' } }),
  useMessagesOperations: () => ({ getMessages: () => [mockMessage], setMessages: jest.fn() }),
}));
jest.mock('~/hooks/Chat', () => ({ useGetAddedConvo: () => () => null }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('recoil', () => ({ useRecoilValue: () => 'ltr' }));
jest.mock('~/store', () => ({ __esModule: true, default: { chatDirection: 'direction' } }));
jest.mock('~/utils', () => ({ cn: () => '', removeFocusRings: '' }));
jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateMessageMutation: () => ({ mutate: mockUpdate }),
}));
jest.mock(
  '../Container',
  () =>
    ({ children }: { children: React.ReactNode }) =>
      children,
);
jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    TextareaAutosize: React.forwardRef(
      (
        props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
        ref: React.ForwardedRef<HTMLTextAreaElement>,
      ) => <textarea {...props} ref={ref} />,
    ),
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
  };
});

beforeEach(() => {
  mockMessage = {
    messageId: 'user',
    conversationId: 'conversation',
    parentMessageId: 'previous',
    isCreatedByUser: true,
    sender: 'User',
    text: '',
    files: [{ file_id: 'saved-file', filepath: '/uploads/input.txt', type: 'text/plain' }],
  };
});
function Editor() {
  return (
    <EditMessage
      message={mockMessage}
      text=""
      isSubmitting={false}
      ask={mockAsk}
      enterEdit={jest.fn()}
      siblingIdx={1}
      setSiblingIdx={jest.fn()}
    />
  );
}
test('Save and Submit retains the exact saved files and empty authored text', async () => {
  render(<Editor />);
  await act(async () => {
    fireEvent.click(screen.getByText('com_ui_save_submit'));
  });
  expect(mockAsk).toHaveBeenCalledWith(
    { text: '', parentMessageId: 'previous', conversationId: 'conversation' },
    { overrideFiles: mockMessage.files, addedConvo: undefined },
  );
});
test('Save preserves empty authored text with the existing file record', async () => {
  const files = mockMessage.files;
  render(<Editor />);
  await act(async () => {
    fireEvent.click(screen.getByText('com_ui_save'));
  });
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'user', text: '' }));
  expect(mockMessage.files).toBe(files);
});
test.each(['no-files', 'assistant'])('blank %s edit remains blocked', async (kind) => {
  if (kind === 'no-files') mockMessage.files = [];
  if (kind === 'assistant') mockMessage.isCreatedByUser = false;
  render(<Editor />);
  await act(async () => {
    fireEvent.click(screen.getByText('com_ui_save_submit'));
  });
  expect(mockAsk).not.toHaveBeenCalled();
});
/* === VIVENTIUM END === */
