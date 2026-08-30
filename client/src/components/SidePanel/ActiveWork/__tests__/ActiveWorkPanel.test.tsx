import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useToastContext } from '@librechat/client';
import {
  useActiveWorkQuery,
  useActiveWorkHistoryQuery,
  useOrchestrationPreferenceQuery,
  useUpdateOrchestrationMutation,
  useWorkActionMutation,
} from '~/data-provider/ViventiumOrchestration';
import ActiveWorkPanel from '../ActiveWorkPanel';

jest.mock('~/data-provider/ViventiumOrchestration', () => ({
  useActiveWorkQuery: jest.fn(),
  useActiveWorkHistoryQuery: jest.fn(),
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
    if (key === 'com_ui_parallel_work_view_named') {
      return `View ${values?.[0]}`;
    }
    if (key === 'com_ui_parallel_work_overflow') {
      return `${values?.[0]} more missions are not shown.`;
    }
    const deliveryLabels: Record<string, string> = {
      com_ui_parallel_work_result_delivered: 'Result delivered.',
      com_ui_parallel_work_failure_reported: 'Failure reported.',
      com_ui_parallel_work_cancellation_reported: 'Cancellation reported.',
      com_ui_parallel_work_result_delivery_failed: 'Result delivery failed.',
      com_ui_parallel_work_result_delivery_unknown: 'Result delivery not confirmed.',
      com_ui_parallel_work_result_delivery_pending: 'Result delivery pending.',
    };
    if (deliveryLabels[key]) return deliveryLabels[key];
    const workLabels: Record<string, string> = {
      com_ui_parallel_work_empty: 'No active work.',
      com_ui_parallel_work_needs_attention: 'Needs attention',
      com_ui_parallel_work_running_queued: 'Running or queued',
      com_ui_parallel_work_recent_results: 'Recent results',
      com_ui_parallel_work_history: 'History',
      com_ui_parallel_work_history_empty: 'No earlier work.',
      com_ui_parallel_work_history_unavailable: 'Work history is unavailable.',
      com_ui_parallel_work_mission: 'Mission',
      com_ui_parallel_work_actions: 'Work actions',
    };
    if (workLabels[key]) return workLabels[key];
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

describe('Active work Control Panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    setPreference();
    setWork();
    (useUpdateOrchestrationMutation as jest.Mock).mockReturnValue(preferenceMutation);
    (useWorkActionMutation as jest.Mock).mockReturnValue(actionMutation);
    (useActiveWorkHistoryQuery as jest.Mock).mockReturnValue({
      data: { snapshot: 'fresh', work: [], overflowCount: 0 },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
      refetch: jest.fn(),
    });
    (useToastContext as jest.Mock).mockReturnValue({ showToast: jest.fn() });
  });

  test('shows the fresh empty roster as operational state', () => {
    render(<ActiveWorkPanel />);

    expect(screen.getByText('No active work.')).toBeInTheDocument();
    expect(useOrchestrationPreferenceQuery).not.toHaveBeenCalled();
    expect(useActiveWorkQuery).toHaveBeenCalled();
  });

  test('keeps existing work and controls visible when launch availability is rolled back', () => {
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

    render(<ActiveWorkPanel />);

    expect(screen.getByText('Keep this mission visible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_parallel_work_action_stop' })).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('breaks long untrusted work labels instead of widening the Control Panel', () => {
    const longTitle = `mission-${'unbroken'.repeat(80)}`;
    setWork({
      work: [
        {
          workRef: 'work-long-title',
          title: longTitle,
          state: 'running',
          provider: 'codex',
          originSurface: 'web',
          statusSummary: longTitle,
          attention: { kind: 'input', summary: longTitle },
          actions: [],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByRole('heading', { name: longTitle }).className).toContain(
      '[overflow-wrap:anywhere]',
    );
    expect(screen.getAllByText(longTitle)).toHaveLength(2);
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

    render(<ActiveWorkPanel />);

    expect(screen.getByText('Research the launch market')).toBeInTheDocument();
    expect(screen.getByText('com_ui_parallel_work_snapshot_stale')).toBeInTheDocument();
    expect(screen.getByText('2 more missions are not shown.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('unsupported-action')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_load_more' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('keeps the active-work pagination action named and busy while the next page loads', () => {
    (useActiveWorkQuery as jest.Mock).mockReturnValue({
      data: { snapshot: 'fresh', overflowCount: 2, work: [] },
      isLoading: false,
      isError: false,
      refetch: refetchWork,
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: true,
    });

    render(<ActiveWorkPanel />);

    const loadMore = screen.getByRole('button', {
      name: 'com_ui_parallel_work_load_more',
    });
    expect(loadMore).toBeDisabled();
    expect(loadMore).toHaveAttribute('aria-busy', 'true');
  });

  test('keeps the History pagination action named and busy while the next page loads', () => {
    (useActiveWorkHistoryQuery as jest.Mock).mockReturnValue({
      data: { snapshot: 'fresh', work: [], overflowCount: 1 },
      isLoading: false,
      isError: false,
      hasNextPage: true,
      isFetchingNextPage: true,
      fetchNextPage: jest.fn(),
      refetch: jest.fn(),
    });

    render(<ActiveWorkPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    const loadMore = screen.getByRole('button', {
      name: 'com_ui_parallel_work_load_more',
    });
    expect(loadMore).toBeDisabled();
    expect(loadMore).toHaveAttribute('aria-busy', 'true');
  });

  test('never presents an unavailable roster as empty', () => {
    setWork({ snapshot: 'unavailable', work: null, overflowCount: null });

    render(<ActiveWorkPanel />);

    expect(screen.getByText('com_ui_parallel_work_unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No active work.')).not.toBeInTheDocument();
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

    render(<ActiveWorkPanel />);
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
    expect(
      screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }),
    ).toHaveAttribute('aria-busy', 'true');
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
    const firstRender = render(<ActiveWorkPanel />);
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
    render(<ActiveWorkPanel />);
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
    const firstRender = render(<ActiveWorkPanel />);
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
    render(<ActiveWorkPanel />);

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
    const firstRender = render(<ActiveWorkPanel />);
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
    render(<ActiveWorkPanel />);
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
    const firstRender = render(<ActiveWorkPanel />);
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
    render(<ActiveWorkPanel />);

    expect(screen.getByLabelText('com_ui_parallel_work_instruction')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'com_ui_parallel_work_action_steer' })).toBeVisible();
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
    render(<ActiveWorkPanel />);
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

  test.each([
    ['pending', 'Result delivery pending.'],
    ['unknown', 'Result delivery not confirmed.'],
    ['failed', 'Result delivery failed.'],
  ])(
    'a rejected dismissal explains %s delivery without claiming the action may have succeeded',
    (deliveryState, expectedMessage) => {
      const showToast = jest.fn();
      (useToastContext as jest.Mock).mockReturnValue({ showToast });
      setWork({
        work: [
          {
            workRef: 'work-dismiss-ref',
            title: 'Preserve the undelivered result',
            state: 'completed',
            delivery: { state: deliveryState, unreadTerminal: true },
            actions: ['dismiss'],
          },
        ],
      });
      render(<ActiveWorkPanel />);
      const dismiss = screen.getByRole('button', {
        name: 'com_ui_parallel_work_action_dismiss',
      });
      fireEvent.click(dismiss);
      const firstCall = actionMutation.mutate.mock.calls[0];

      act(() => {
        firstCall[1].onError({
          response: {
            status: 409,
            data: { error: { code: 'glasshive_dismiss_delivery_not_settled' } },
          },
        });
        firstCall[1].onSettled();
      });

      expect(screen.getByText('Preserve the undelivered result')).toBeVisible();
      expect(screen.queryByText('com_ui_parallel_work_action_uncertain')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'com_ui_parallel_work_action_retry_same' }),
      ).not.toBeInTheDocument();
      expect(showToast).toHaveBeenCalledWith({ message: expectedMessage, status: 'error' });

      fireEvent.click(dismiss);
      expect(actionMutation.mutate.mock.calls[1][0].operationId).not.toBe(firstCall[0].operationId);
    },
  );

  test('a conflict without a definitive rejection remains safely uncertain', () => {
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
    render(<ActiveWorkPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_pause' }));
    const firstCall = actionMutation.mutate.mock.calls[0];

    act(() => {
      firstCall[1].onError({
        response: { status: 409, data: { error: { code: 'glasshive_action_outcome_unknown' } } },
      });
      firstCall[1].onSettled();
    });

    expect(screen.getByText('com_ui_parallel_work_action_uncertain')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_action_retry_same' }));
    expect(actionMutation.mutate.mock.calls[1][0].operationId).toBe(firstCall[0].operationId);
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

    render(<ActiveWorkPanel />);
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

    render(<ActiveWorkPanel />);

    expect(screen.getByText('Mission: running · claude · telegram')).toBeInTheDocument();
    expect(screen.getByText('2/3 native workers active · 1 needs attention')).toBeInTheDocument();
    expect(screen.queryByText('Delivery: pending')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Prepare the durable report' })).toHaveAttribute(
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

  test('does not expose executable or unsupported mission links', () => {
    setWork({
      work: [
        {
          workRef: 'unsafe-mission',
          title: 'Unsafe detail reference',
          state: 'running',
          viewRef: 'javascript:alert(1)',
          actions: [],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByText('Unsafe detail reference')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('groups attention, live missions, and recent results without duplicate failure copy', () => {
    setWork({
      work: [
        {
          workRef: 'work-result',
          title: 'Finished mission',
          state: 'completed',
          statusSummary: 'Completed',
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: ['dismiss'],
        },
        {
          workRef: 'work-running',
          title: 'Running mission',
          state: 'running',
          delivery: { state: 'pending', unreadTerminal: false },
          actions: ['pause'],
        },
        {
          workRef: 'work-attention',
          title: 'Blocked mission',
          state: 'failed',
          statusSummary: 'Sign-in is required.',
          attention: { kind: 'auth', summary: 'Sign-in is required.' },
          delivery: { state: 'failed', unreadTerminal: true },
          actions: ['retry'],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    const attention = screen.getByRole('heading', { name: 'Needs attention' });
    const active = screen.getByRole('heading', { name: 'Running or queued' });
    const results = screen.getByRole('heading', { name: 'Recent results' });
    expect(attention.compareDocumentPosition(active)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(active.compareDocumentPosition(results)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getAllByText('Sign-in is required.')).toHaveLength(1);
    expect(screen.getAllByText('Blocked mission')).toHaveLength(1);
    expect(screen.getByText('Mission: failed')).toBeVisible();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  test('puts paused, input-blocked, and worker-blocked missions in the attention section', () => {
    setWork({
      work: [
        {
          workRef: 'paused-mission',
          title: 'Paused mission',
          state: 'paused',
          actions: ['resume'],
        },
        {
          workRef: 'input-mission',
          title: 'Input is required',
          state: 'needs_input',
          actions: [],
        },
        {
          workRef: 'worker-mission',
          title: 'Worker needs attention',
          state: 'running',
          nativeTeam: { active: 1, total: 2, needsAttention: 1, degraded: false },
          actions: ['pause'],
        },
        {
          workRef: 'queued-mission',
          title: 'Queued mission',
          state: 'queued',
          actions: [],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    const attention = within(screen.getByRole('region', { name: 'Needs attention' }));
    const running = within(screen.getByRole('region', { name: 'Running or queued' }));
    expect(attention.getByText('Paused mission')).toBeVisible();
    expect(attention.getByText('Input is required')).toBeVisible();
    expect(attention.getByText('Worker needs attention')).toBeVisible();
    expect(running.getByText('Queued mission')).toBeVisible();
    expect(running.queryByText('Paused mission')).not.toBeInTheDocument();
    expect(running.queryByText('Input is required')).not.toBeInTheDocument();
  });

  test('does not treat terminal missions or stale worker counts as active work', () => {
    setWork({
      work: [
        {
          workRef: 'terminal-result',
          title: 'Completed mission',
          state: 'completed',
          nativeTeam: { active: 1, total: 1, needsAttention: 0, degraded: false },
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: ['dismiss'],
        },
        {
          workRef: 'terminal-failure',
          title: 'Failed mission',
          state: 'failed',
          nativeTeam: { active: 3, total: 3, needsAttention: 2, degraded: true },
          delivery: { state: 'failed', unreadTerminal: true },
          actions: ['retry'],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByText('No active work.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Recent results' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Running or queued' })).not.toBeInTheDocument();
    expect(screen.queryByText(/native workers active/i)).not.toBeInTheDocument();
  });

  test('does not claim the active roster is empty while hidden missions remain unclassified', () => {
    setWork({
      work: [
        {
          workRef: 'terminal-result',
          title: 'Completed mission',
          state: 'completed',
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: [],
        },
      ],
      overflowCount: 1,
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByText('1 more missions are not shown.')).toBeVisible();
    expect(screen.queryByText('No active work.')).not.toBeInTheDocument();
    expect(screen.queryByText(/more active/i)).not.toBeInTheDocument();
  });

  test('shows worker-runtime counts only when they add meaningful mission detail', () => {
    setWork({
      work: [
        {
          workRef: 'single-worker',
          title: 'One ordinary worker',
          state: 'running',
          nativeTeam: { active: 1, total: 1, needsAttention: 0, degraded: false },
          actions: [],
        },
        {
          workRef: 'worker-team',
          title: 'Multiple workers',
          state: 'running',
          nativeTeam: { active: 2, total: 3, needsAttention: 0, degraded: false },
          actions: [],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(
      screen.queryByText('1/1 native workers active · 0 needs attention'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('2/3 native workers active · 0 needs attention')).toBeVisible();
  });

  test('deduplicates failure details across normalized summaries and delivery state', () => {
    setWork({
      work: [
        {
          workRef: 'attention-failure',
          title: 'Authorization failed',
          state: 'failed',
          statusSummary: '  Authorization is required.  ',
          attention: { kind: 'auth', summary: 'authorization is REQUIRED.' },
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: ['retry'],
        },
        {
          workRef: 'delivery-failure',
          title: 'Result needs delivery',
          state: 'completed',
          statusSummary: '  result delivery FAILED.  ',
          delivery: { state: 'failed', unreadTerminal: true },
          actions: [],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(screen.getAllByText(/authorization is required\./i)).toHaveLength(1);
    expect(screen.getAllByText(/result delivery failed\./i)).toHaveLength(1);
    expect(screen.getByText(/com_ui_parallel_work_delivery_unread/)).toBeVisible();
  });

  test('labels terminal delivery by user meaning instead of contradictory transport state', () => {
    setWork({
      work: [
        {
          workRef: 'completed-delivered',
          title: 'Completed delivery',
          state: 'completed',
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: [],
        },
        {
          workRef: 'failed-reported',
          title: 'Failed but reported',
          state: 'failed',
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: [],
        },
        {
          workRef: 'delivery-failed',
          title: 'Delivery failed',
          state: 'completed',
          delivery: { state: 'failed', unreadTerminal: true },
          actions: [],
        },
        {
          workRef: 'delivery-unknown',
          title: 'Delivery unknown',
          state: 'completed',
          delivery: { state: 'unknown', unreadTerminal: true },
          actions: [],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByText('Result delivered.')).toBeVisible();
    expect(screen.getByText('Failure reported.')).toBeVisible();
    expect(screen.getByText(/Result delivery failed\./)).toBeVisible();
    expect(screen.getByText(/Result delivery not confirmed\./)).toBeVisible();
    expect(screen.queryByText('Delivery: delivered')).not.toBeInTheDocument();
  });

  test('uses full-size controls and calls overflow rows missions', () => {
    setWork({
      work: [
        {
          workRef: 'work-sized',
          title: 'Sized mission',
          state: 'failed',
          viewRef: 'https://glasshive.example.test/w/safe-ref',
          delivery: { state: 'failed', unreadTerminal: true },
          actions: ['retry'],
        },
      ],
      overflowCount: 2,
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByRole('button', { name: 'com_ui_parallel_work_action_retry' })).toHaveClass(
      'min-h-11',
    );
    expect(screen.getByRole('link', { name: 'View Sized mission' })).toHaveClass('min-h-11');
    expect(screen.getByText('2 more missions are not shown.')).toBeVisible();
    expect(screen.queryByText(/active items/i)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Work actions' })).toBeVisible();
  });

  test('keeps artifact and instruction controls visible to keyboard and low-vision users', () => {
    setWork({
      work: [
        {
          workRef: 'work-accessible',
          title: 'Accessible mission',
          state: 'running',
          viewRef: 'https://glasshive.example.test/w/safe-ref',
          delivery: { state: 'pending', unreadTerminal: false },
          actions: ['steer'],
        },
      ],
    });

    render(<ActiveWorkPanel />);

    expect(screen.getByRole('link', { name: 'View Accessible mission' })).toHaveClass(
      'min-h-11',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-text-primary',
    );
    expect(screen.getByRole('textbox', { name: 'com_ui_parallel_work_instruction' })).toHaveClass(
      'border-border-xheavy',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-offset-2',
    );
  });

  test('loads and renders History only after its keyboard-operated disclosure opens', async () => {
    (useActiveWorkHistoryQuery as jest.Mock).mockImplementation(({ enabled }) => ({
      data: enabled
        ? {
            snapshot: 'fresh',
            work: [
              {
                workRef: 'history-item',
                title: 'Past mission',
                state: 'completed',
                delivery: { state: 'delivered', unreadTerminal: false },
                actions: [],
              },
            ],
            overflowCount: 0,
          }
        : undefined,
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
      refetch: jest.fn(),
    }));

    render(<ActiveWorkPanel />);
    expect(useActiveWorkHistoryQuery).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByText('Past mission')).not.toBeInTheDocument();

    const user = userEvent.setup();
    const history = screen.getByRole('button', { name: 'History' });
    await user.tab();
    expect(history).toHaveFocus();
    expect(history).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');

    expect(useActiveWorkHistoryQuery).toHaveBeenLastCalledWith({ enabled: true });
    expect(history).toHaveAttribute('aria-expanded', 'true');
    expect(history).toHaveAttribute('aria-controls', 'active-work-history-panel');
    expect(screen.getByText('Past mission')).toBeVisible();

    await user.keyboard('{Enter}');
    expect(history).toHaveAttribute('aria-expanded', 'false');
    expect(history).not.toHaveAttribute('aria-controls');
    expect(useActiveWorkHistoryQuery).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByText('Past mission')).not.toBeInTheDocument();
  });

  test('keeps History terminal-only and does not repeat current or duplicate missions', () => {
    const current = {
      workRef: 'current-terminal',
      title: 'Current result',
      state: 'completed',
      delivery: { state: 'delivered', unreadTerminal: false },
      actions: [],
    };
    const earlier = {
      workRef: 'earlier-terminal',
      title: 'Earlier result',
      state: 'completed',
      delivery: { state: 'delivered', unreadTerminal: false },
      actions: [],
    };
    setWork({ work: [current] });
    (useActiveWorkHistoryQuery as jest.Mock).mockImplementation(({ enabled }) => ({
      data: enabled
        ? {
            snapshot: 'fresh',
            work: [
              current,
              earlier,
              earlier,
              {
                workRef: 'history-live',
                title: 'Live work does not belong in History',
                state: 'running',
                actions: [],
              },
            ],
            overflowCount: 0,
          }
        : undefined,
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
      refetch: jest.fn(),
    }));

    render(<ActiveWorkPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.getAllByText('Current result')).toHaveLength(1);
    expect(screen.getAllByText('Earlier result')).toHaveLength(1);
    expect(screen.queryByText('Live work does not belong in History')).not.toBeInTheDocument();
  });

  test('keeps earlier pages discoverable when the first History page only repeats current work', () => {
    const current = {
      workRef: 'current-terminal',
      title: 'Current result',
      state: 'completed',
      delivery: { state: 'delivered', unreadTerminal: false },
      actions: [],
    };
    const fetchHistoryPage = jest.fn();
    setWork({ work: [current] });
    (useActiveWorkHistoryQuery as jest.Mock).mockReturnValue({
      data: { snapshot: 'fresh', work: [current], overflowCount: 1 },
      isLoading: false,
      isError: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: fetchHistoryPage,
      refetch: jest.fn(),
    });

    render(<ActiveWorkPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.queryByText('No earlier work.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_parallel_work_load_more' }));
    expect(fetchHistoryPage).toHaveBeenCalledTimes(1);
  });

  test('reports an unavailable History snapshot and exposes its recovery control', () => {
    const retryHistory = jest.fn();
    (useActiveWorkHistoryQuery as jest.Mock).mockReturnValue({
      data: { snapshot: 'unavailable', work: null, overflowCount: null },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
      refetch: retryHistory,
    });

    render(<ActiveWorkPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.getByText('Work history is unavailable.')).toBeVisible();
    expect(screen.queryByText('No earlier work.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(retryHistory).toHaveBeenCalledTimes(1);
  });
});
