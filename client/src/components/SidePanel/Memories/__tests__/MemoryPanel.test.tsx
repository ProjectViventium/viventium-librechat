import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { MemoriesResponse, TUserMemory } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import MemoryPanel from '../MemoryPanel';
import MemoryCard from '../MemoryCard';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getMemories: jest.fn() } };
});

jest.mock('~/data-provider', () => ({
  useMemoriesQuery: jest.requireActual('~/data-provider/Memories/queries').useMemoriesQuery,
  useGetUserQuery: () => ({
    data: { personalization: { memories: true, conversation_recall: false } },
  }),
  useUpdateMemoryPreferencesMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => mockTranslations[key as keyof typeof mockTranslations] ?? key,
  useAuthContext: () => ({ user: { role: 'USER' } }),
  useHasAccess: () => true,
}));
jest.mock('~/utils', () => ({ cn: (...values: string[]) => values.join(' ') }));
jest.mock('../AdminSettings', () => () => null);
jest.mock('../MemoryUsageBadge', () => () => null);
jest.mock('../MemoryCreateDialog', () => ({ children }: { children: React.ReactNode }) => (
  <>{children}</>
));
jest.mock('../MemoryCardActions', () => () => (
  <>
    <button>{mockTranslations.com_ui_edit}</button>
    <button>{mockTranslations.com_ui_delete}</button>
  </>
));
jest.mock('@librechat/client', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props} />
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    'aria-label'?: string;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
  Spinner: () => <span aria-label="Loading" />,
  FilterInput: ({
    inputId,
    label,
    value,
    onChange,
  }: {
    inputId: string;
    label: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <label htmlFor={inputId}>
      {label}
      <input id={inputId} value={value} onChange={onChange} />
    </label>
  ),
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => <>{content}</>,
  OGDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

const memory: TUserMemory = {
  key: 'preferences',
  value: 'First line\n_confirmed: literal saved content\n<div>Keep these exact words.</div>',
  tokenCount: 46,
  revision: 3,
  updated_at: '2026-09-04T00:00:00Z',
};
const response = (memories: TUserMemory[]): MemoriesResponse => ({
  memories,
  totalTokens: 46,
  tokenLimit: 8000,
  usagePercentage: 1,
  validKeys: ['preferences'],
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryPanel />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

describe('Memories reading and recovery', () => {
  const loadMemories = dataService.getMemories as jest.MockedFunction<
    typeof dataService.getMemories
  >;
  beforeEach(() => loadMemories.mockReset());

  test('an initial read failure offers Retry instead of claiming no memories, then recovers', async () => {
    const load = loadMemories
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response([memory]));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Saved memories could not be loaded.',
    );
    expect(screen.queryByText(mockTranslations.com_ui_no_memories_title)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('preferences')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a failed refresh retains saved text with a stale notice until Retry succeeds', async () => {
    const load = loadMemories
      .mockResolvedValueOnce(response([memory]))
      .mockRejectedValueOnce(new Error('offline'));
    const { client } = renderPanel();
    await screen.findByText('preferences');
    await act(async () => {
      await client.invalidateQueries([QueryKeys.memories]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These memories may be out of date.',
    );
    expect(screen.getByText('preferences')).toBeInTheDocument();
    let complete!: (value: MemoriesResponse) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled());
    expect(screen.getByRole('alert')).toHaveTextContent('These memories may be out of date.');
    expect(screen.getByText('preferences')).toBeInTheDocument();
    await act(async () => {
      complete(response([{ ...memory, value: 'Updated preference', revision: 4 }]));
    });
    expect(await screen.findByText('Updated preference')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a failed refresh of an old empty result is not a current empty-state claim', async () => {
    loadMemories.mockResolvedValueOnce(response([])).mockRejectedValueOnce(new Error('offline'));
    const { client } = renderPanel();
    await screen.findByText(mockTranslations.com_ui_no_memories_title);
    await act(async () => {
      await client.invalidateQueries([QueryKeys.memories]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These memories may be out of date.',
    );
    expect(screen.queryByText(mockTranslations.com_ui_no_memories_title)).not.toBeInTheDocument();
  });

  test('Retry clamps a removed page and retains the search instead of showing a false empty state', async () => {
    const memories = Array.from({ length: 11 }, (_, index) => ({
      ...memory,
      key: `key_${String(index).padStart(2, '0')}`,
      value: `Saved fact ${String(index).padStart(2, '0')}`,
    }));
    loadMemories
      .mockResolvedValueOnce(response(memories))
      .mockRejectedValueOnce(new Error('offline'));
    const { client } = renderPanel();
    await screen.findByText('Saved fact 00');
    const search = screen.getByRole('textbox', { name: mockTranslations.com_ui_memories_filter });
    fireEvent.change(search, { target: { value: 'Saved' } });
    fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_next }));
    await screen.findByText('Saved fact 10');
    await act(async () => {
      await client.invalidateQueries([QueryKeys.memories]);
    });
    await screen.findByRole('alert');
    loadMemories.mockResolvedValueOnce(response([{ ...memory, value: 'Saved remaining fact' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Saved remaining fact')).toBeInTheDocument();
    expect(search).toHaveValue('Saved');
    expect(screen.queryByText(mockTranslations.com_ui_no_memories_title)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: mockTranslations.com_ui_next }),
    ).not.toBeInTheDocument();
  });

  test('Retry keeps the selected page when the refreshed list still contains it', async () => {
    const memories = Array.from({ length: 12 }, (_, index) => ({
      ...memory,
      key: `key_${String(index).padStart(2, '0')}`,
      value: `Original fact ${String(index).padStart(2, '0')}`,
    }));
    loadMemories
      .mockResolvedValueOnce(response(memories))
      .mockRejectedValueOnce(new Error('offline'));
    const { client } = renderPanel();
    await screen.findByText('Original fact 00');
    fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_next }));
    await screen.findByText('Original fact 10');
    await act(async () => {
      await client.invalidateQueries([QueryKeys.memories]);
    });
    await screen.findByRole('alert');
    loadMemories.mockResolvedValueOnce(
      response(
        memories.map((item) => ({ ...item, value: item.value.replace('Original', 'Updated') })),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Updated fact 10')).toBeInTheDocument();
    expect(screen.queryByText('Updated fact 00')).not.toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  test('a successful empty result keeps the existing empty state', async () => {
    loadMemories.mockResolvedValue(response([]));
    renderPanel();
    expect(await screen.findByText(mockTranslations.com_ui_no_memories_title)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  test('the exact saved value leads the card without duplicate technical metadata', () => {
    const { container } = render(<MemoryCard memory={memory} hasUpdateAccess />);
    const paragraph = container.querySelector('p')!;
    const key = screen.getByText(memory.key);
    expect(paragraph.textContent).toBe(memory.value);
    expect(paragraph.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/46 tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
    expect(paragraph.querySelector('div')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  test('read-only access still exposes the exact saved value without edit actions', () => {
    const { container } = render(<MemoryCard memory={memory} hasUpdateAccess={false} />);
    expect(container.querySelector('p')!.textContent).toBe(memory.value);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
