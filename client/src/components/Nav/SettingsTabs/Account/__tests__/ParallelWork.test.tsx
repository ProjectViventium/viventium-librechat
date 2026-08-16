import { act, fireEvent, render, screen } from '@testing-library/react';
import { useToastContext } from '@librechat/client';
import {
  useActiveWorkQuery,
  useOrchestrationPreferenceQuery,
  useUpdateOrchestrationMutation,
  useWorkActionMutation,
} from '~/data-provider/ViventiumOrchestration';
import ParallelWork from '../ParallelWork';

jest.mock('~/data-provider/ViventiumOrchestration', () => ({
  useActiveWorkQuery: jest.fn(),
  useOrchestrationPreferenceQuery: jest.fn(),
  useUpdateOrchestrationMutation: jest.fn(),
  useWorkActionMutation: jest.fn(),
}));
jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      {...props}
    />
  ),
  useToastContext: jest.fn(),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(() => ({ user: { id: 'owner-a' } })),
  useLocalize: () => (key: string, values?: Record<number, string | number>) => {
    if (key === 'com_ui_parallel_work_native_team') {
      return `${values?.[0]}/${values?.[1]} native workers active · ${values?.[2]} needs attention`;
    }
    if (key === 'com_ui_parallel_work_delivery') {
      return `Delivery: ${values?.[0]}`;
    }
    return key;
  },
}));

const preferenceMutation = { mutate: jest.fn(), isLoading: false };
const actionMutation = { mutate: jest.fn(), isLoading: false };
const refetchWork = jest.fn();
const fetchNextPage = jest.fn();

const setPreference = (mode: 'focused' | 'parallel' = 'focused') => {
  (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
    data: { available: true, mode },
    isLoading: false,
    isError: false,
  });
};

const setWork = (overrides: Record<string, unknown> = {}) => {
  (useActiveWorkQuery as jest.Mock).mockReturnValue({
    data: { snapshot: 'fresh', work: [], overflowCount: 0, ...overrides },
    isLoading: false,
    isError: false,
    refetch: refetchWork,
    fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
  });
};

describe('Parallel work account control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    setPreference();
    setWork();
    (useUpdateOrchestrationMutation as jest.Mock).mockReturnValue(preferenceMutation);
    (useWorkActionMutation as jest.Mock).mockReturnValue(actionMutation);
    (useToastContext as jest.Mock).mockReturnValue({ showToast: jest.fn() });
  });

  test('hides a fresh empty board but still checks for durable work during rollback', () => {
    render(<ParallelWork featureAvailable={false} />);

    expect(screen.queryByText('com_ui_parallel_work')).not.toBeInTheDocument();
    expect(useOrchestrationPreferenceQuery).toHaveBeenCalled();
    expect(useActiveWorkQuery).toHaveBeenCalled();
  });

  test('keeps existing work and controls visible when launch availability is rolled back', () => {
    setPreference();
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: { available: false, mode: 'focused' },
      isLoading: false,
      isError: false,
    });
    setWork({
      work: [
        {
          workRef: 'work-still-running',
          title: 'Keep this mission visible',
          state: 'running',
          actions: ['stop'],
        },
      ],
    });

    render(<ParallelWork featureAvailable={false} />);

    expect(screen.getByText('Keep this mission visible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_parallel_work_action_stop' })).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('shows the focused default and updates the account-wide mode', () => {
    render(<ParallelWork featureAvailable />);

    const toggle = screen.getByRole('checkbox', { name: 'com_ui_parallel_work' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(preferenceMutation.mutate).toHaveBeenCalledWith(
      { mode: 'parallel' },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(screen.getByText('com_ui_parallel_work_snapshot_fresh')).toBeInTheDocument();
    expect(screen.getByText('com_ui_parallel_work_empty')).toBeInTheDocument();
  });

  test('keeps active work visible in focused mode and distinguishes stale state and overflow', () => {
    (useActiveWorkQuery as jest.Mock).mockReturnValue({
      data: {
        snapshot: 'stale',
        overflowCount: 2,
        work: [
          {
            workRef: 'work-safe-ref',
            title: 'Research the launch market',
            state: 'running',
            statusSummary: 'Comparing primary sources',
            actions: ['pause', 'unsupported-action'],
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: refetchWork,
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: false,
    });

    render(<ParallelWork featureAvailable />);

    expect(screen.getByText('Research the launch market')).toBeInTheDocument();
    expect(screen.getByText('com_ui_parallel_work_snapshot_stale')).toBeInTheDocument();
    expect(screen.getByText('com_ui_parallel_work_overflow')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('unsupported-action')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_load_more' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('never presents an unavailable roster as empty', () => {
    setWork({ snapshot: 'unavailable', work: null, overflowCount: null });

    render(<ParallelWork featureAvailable />);

    expect(screen.getByText('com_ui_parallel_work_unavailable')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_parallel_work_empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetchWork).toHaveBeenCalledTimes(1);
  });

  test('sends only an allowed masked action with a client operation UUID', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Build the report',
          state: 'running',
          actions: ['pause'],
        },
      ],
    });

    render(<ParallelWork featureAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }));

    expect(actionMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workRef: 'work-safe-ref',
        action: 'pause',
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      }),
      expect.any(Object),
    );
    expect(actionMutation.mutate.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
  });

  test('retries a lost-response action with the same durable operation after remount', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Build the report',
          state: 'running',
          actions: ['pause'],
        },
      ],
    });
    const firstRender = render(<ParallelWork featureAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }));
    const firstCall = actionMutation.mutate.mock.calls[0];
    const firstOperationId = firstCall[0].operationId;

    act(() => {
      firstCall[1].onError(new Error('response lost'));
      firstCall[1].onSettled();
    });
    expect(
      screen.getByRole('button', { name: 'com_ui_parallel_work_action_retry_same' }),
    ).toBeVisible();
    expect(screen.getByText('com_ui_parallel_work_action_uncertain')).toBeVisible();

    firstRender.unmount();
    render(<ParallelWork featureAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_retry_same' }));

    expect(actionMutation.mutate.mock.calls[1][0].operationId).toBe(firstOperationId);
  });

  test('keeps an uncertain operation retryable after its committed state changes the action mask', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Build the report',
          state: 'running',
          actions: ['pause'],
        },
      ],
    });
    const firstRender = render(<ParallelWork featureAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }));
    const firstCall = actionMutation.mutate.mock.calls[0];
    const firstOperationId = firstCall[0].operationId;
    act(() => {
      firstCall[1].onError(new Error('response lost after commit'));
      firstCall[1].onSettled();
    });
    firstRender.unmount();

    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Build the report',
          state: 'paused',
          actions: ['resume', 'stop'],
        },
      ],
    });
    render(<ParallelWork featureAvailable />);

    const retry = screen.getByRole('button', {
      name: 'com_ui_parallel_work_action_retry_same',
    });
    expect(retry).toBeVisible();
    expect(screen.getByText('com_ui_parallel_work_action_uncertain')).toBeVisible();
    fireEvent.click(retry);
    expect(actionMutation.mutate.mock.calls[1][0]).toMatchObject({
      workRef: 'work-safe-ref',
      action: 'pause',
      operationId: firstOperationId,
    });
  });

  test('a changed draft cannot alter the retained instruction for an uncertain operation', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Research vendors',
          state: 'running',
          actions: ['steer'],
        },
      ],
    });
    const firstRender = render(<ParallelWork featureAvailable />);
    fireEvent.change(screen.getByLabelText('com_ui_parallel_work_instruction'), {
      target: { value: 'Preserve this exact instruction.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_steer' }));
    const firstCall = actionMutation.mutate.mock.calls[0];
    act(() => {
      firstCall[1].onError(new Error('response lost'));
      firstCall[1].onSettled();
    });

    firstRender.unmount();
    render(<ParallelWork featureAvailable />);
    const input = screen.getByLabelText('com_ui_parallel_work_instruction');
    expect(input).toHaveValue('Preserve this exact instruction.');
    fireEvent.change(input, { target: { value: 'A changed draft must not alter the retry.' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_retry_same' }));

    const replay = actionMutation.mutate.mock.calls[1][0];
    expect(replay.operationId).toBe(firstCall[0].operationId);
    expect(replay.instruction).toBe('Preserve this exact instruction.');
  });

  test('never exposes or reuses an uncertain instruction across accounts', () => {
    const { useAuthContext } = jest.requireMock('~/hooks') as {
      useAuthContext: jest.Mock;
    };
    setWork({
      work: [
        {
          workRef: 'work-same-opaque-ref',
          title: 'Private mission',
          state: 'running',
          actions: ['steer'],
        },
      ],
    });
    const firstRender = render(<ParallelWork featureAvailable />);
    fireEvent.change(screen.getByLabelText('com_ui_parallel_work_instruction'), {
      target: { value: 'Owner A private instruction.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_steer' }));
    const firstCall = actionMutation.mutate.mock.calls[0];
    act(() => {
      firstCall[1].onError(new Error('response lost'));
      firstCall[1].onSettled();
    });
    firstRender.unmount();

    useAuthContext.mockReturnValue({ user: { id: 'owner-b' } });
    render(<ParallelWork featureAvailable />);

    expect(screen.getByLabelText('com_ui_parallel_work_instruction')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'com_ui_parallel_work_action_steer' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'com_ui_parallel_work_action_retry_same' }),
    ).not.toBeInTheDocument();
  });

  test('a definitive action rejection releases its operation id', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Build the report',
          state: 'running',
          actions: ['pause'],
        },
      ],
    });
    render(<ParallelWork featureAvailable />);
    const button = screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' });
    fireEvent.click(button);
    const firstCall = actionMutation.mutate.mock.calls[0];

    act(() => {
      firstCall[1].onError({ response: { status: 400 } });
      firstCall[1].onSettled();
    });
    fireEvent.click(button);

    expect(actionMutation.mutate.mock.calls[1][0].operationId).not.toBe(firstCall[0].operationId);
  });

  test('requires an instruction before message or steer actions', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Research vendors',
          state: 'running',
          actions: ['message', 'steer'],
        },
      ],
    });

    render(<ParallelWork featureAvailable />);
    const message = screen.getByRole('button', {
      name: 'com_ui_parallel_work_action_message',
    });
    expect(message).toBeDisabled();

    fireEvent.change(screen.getByLabelText('com_ui_parallel_work_instruction'), {
      target: { value: 'Prioritize official pricing.' },
    });
    fireEvent.click(message);

    expect(actionMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workRef: 'work-safe-ref',
        action: 'message',
        instruction: 'Prioritize official pricing.',
      }),
      expect.any(Object),
    );
  });

  test('renders safe mission detail, native-team, delivery, and queued-follow-up truth', () => {
    setWork({
      work: [
        {
          workRef: 'work-safe-ref',
          title: 'Prepare the durable report',
          state: 'running',
          provider: 'claude',
          originSurface: 'telegram',
          viewRef: 'https://glasshive.example.com/r/safe-ref',
          nativeTeam: { active: 2, total: 3, needsAttention: 1, degraded: false },
          delivery: { state: 'pending', unreadTerminal: false },
          actions: ['queue'],
        },
      ],
    });

    render(<ParallelWork featureAvailable />);

    expect(screen.getByText('claude · telegram')).toBeInTheDocument();
    expect(screen.getByText('2/3 native workers active · 1 needs attention')).toBeInTheDocument();
    expect(screen.getByText('Delivery: pending')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'com_ui_parallel_work_view' })).toHaveAttribute(
      'href',
      'https://glasshive.example.com/r/safe-ref',
    );
    const queue = screen.getByRole('button', {
      name: 'com_ui_parallel_work_action_queue',
    });
    expect(queue).toBeDisabled();
    fireEvent.change(screen.getByLabelText('com_ui_parallel_work_instruction'), {
      target: { value: 'After this, compare the two launch scenarios.' },
    });
    fireEvent.click(queue);
    expect(actionMutation.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workRef: 'work-safe-ref',
        action: 'queue',
        instruction: 'After this, compare the two launch scenarios.',
      }),
      expect.any(Object),
    );
  });
});
