import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PendingNativeWorkInput } from 'librechat-data-provider';
import NativeWorkInput from '../NativeWorkInput';

const mockMutate = jest.fn();
jest.mock('~/data-provider/ViventiumOrchestration', () => ({
  useWorkActionMutation: () => ({ mutate: mockMutate, isLoading: false, isSuccess: false }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
const input: PendingNativeWorkInput = {
  version: 1,
  requestId: 'request-1',
  requestFingerprint: 'a'.repeat(64),
  kind: 'elicitation',
  mcpServerName: 'Computer',
  message: 'Allow access to the selected app?',
  mode: 'form',
  state: 'pending',
  requestedSchema: { type: 'object', properties: {} },
};
beforeEach(() => {
  mockMutate.mockReset();
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: () => 'f120c93a-14d3-42bd-b8e2-fbd59bfb058c',
  });
});
it('waits for a real choice and preserves decline without accepting defaults', () => {
  render(<NativeWorkInput workRef="work-1" input={input} />);
  expect(mockMutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('com_ui_decline'));
  expect(mockMutate.mock.calls[0][0]).toMatchObject({
    action: 'resume',
    workRef: 'work-1',
    nativeInput: {
      action: 'decline',
      requestId: input.requestId,
      requestFingerprint: input.requestFingerprint,
    },
  });
  expect(mockMutate.mock.calls[0][0].nativeInput.content).toBeUndefined();
});
it('uses submitted typed values, not schema defaults', () => {
  render(
    <NativeWorkInput
      workRef="work-1"
      input={{
        ...input,
        requestedSchema: {
          type: 'object',
          properties: {
            consent: { type: 'boolean', title: 'Consent', default: true },
            amount: { type: 'integer', title: 'Count', minimum: 1 },
          },
          required: ['consent', 'amount'],
        },
      }}
    />,
  );
  expect(screen.getByLabelText('Consent')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Consent'), { target: { value: 'false' } });
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '3' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(mockMutate.mock.calls[0][0].nativeInput.content).toEqual({ consent: false, amount: 3 });
});
it('retries the identical response after an uncertain network outcome', () => {
  render(<NativeWorkInput workRef="work-1" input={input} />);
  fireEvent.click(screen.getByText('com_ui_continue'));
  const first = mockMutate.mock.calls[0][0];
  act(() => mockMutate.mock.calls[0][1].onError(new Error('network')));
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByText('com_ui_decline')).toBeDisabled();
  fireEvent.click(screen.getByText('com_ui_continue'));
  expect(mockMutate.mock.calls[1][0]).toEqual(first);
});
it('does not open an executable URL or report approval', () => {
  render(
    <NativeWorkInput
      workRef="work-1"
      input={{ ...input, mode: 'url', url: 'javascript:alert(1)' }}
    />,
  );
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText('com_ui_continue')).toBeDisabled();
  expect(mockMutate).not.toHaveBeenCalled();
});

it('lets the owner correct a rejected form without reusing the rejected response', () => {
  render(
    <NativeWorkInput
      workRef="work-1"
      input={{
        ...input,
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
          },
        },
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'old' } });
  fireEvent.submit(screen.getByRole('form'));
  act(() => mockMutate.mock.calls[0][1].onError({ response: { status: 422 } }));
  expect(screen.getByLabelText('Name')).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'corrected' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(mockMutate.mock.calls[1][0].nativeInput.content).toEqual({ name: 'corrected' });
});

it('omits cleared optional typed fields instead of inventing false or an invalid number', () => {
  render(
    <NativeWorkInput
      workRef="work-1"
      input={{
        ...input,
        requestedSchema: {
          type: 'object',
          properties: {
            consent: { type: 'boolean', title: 'Consent' },
            count: { type: 'integer', title: 'Count' },
            scope: {
              type: 'string',
              title: 'Scope',
              oneOf: [{ const: 'session', title: 'For this task' }],
            },
          },
        },
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Consent'), { target: { value: 'true' } });
  fireEvent.change(screen.getByLabelText('Consent'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'session' } });
  fireEvent.change(screen.getByLabelText('Scope'), { target: { value: '' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(mockMutate.mock.calls[0][0].nativeInput.content).toEqual({});
});
