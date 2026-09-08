import { fireEvent, render, screen } from '@testing-library/react';
import { useToastContext } from '@librechat/client';
import {
  useActiveWorkQuery,
  useOrchestrationPreferenceQuery,
  useUpdateOrchestrationMutation,
} from '~/data-provider/ViventiumOrchestration';
import ParallelWork from '../ParallelWork';

jest.mock('~/data-provider/ViventiumOrchestration', () => ({
  useActiveWorkQuery: jest.fn(),
  useOrchestrationPreferenceQuery: jest.fn(),
  useUpdateOrchestrationMutation: jest.fn(),
}));
jest.mock('@librechat/client', () => ({
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
  useLocalize: () => (key: string) => key,
}));

const preferenceMutation = { mutate: jest.fn(), isLoading: false };

describe('Parallel work account preference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: { available: true, mode: 'focused' },
      isLoading: false,
      isError: false,
    });
    (useUpdateOrchestrationMutation as jest.Mock).mockReturnValue(preferenceMutation);
    (useToastContext as jest.Mock).mockReturnValue({ showToast: jest.fn() });
  });

  test('uses owner readiness without a deployment release flag', () => {
    render(<ParallelWork />);

    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeEnabled();
    expect(useOrchestrationPreferenceQuery).toHaveBeenCalled();
    expect(useActiveWorkQuery).not.toHaveBeenCalled();
  });

  test('shows the effect of switching off when parallel work is ready and on', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: { available: true, mode: 'parallel' },
      isLoading: false,
      isError: false,
    });
    render(<ParallelWork />);

    const toggle = screen.getByRole('checkbox', { name: 'com_ui_parallel_work' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('com_ui_parallel_work_existing_work')).toBeVisible();
    expect(toggle).toHaveAccessibleDescription(
      'com_ui_parallel_work_description com_ui_parallel_work_existing_work',
    );
  });

  test('shows only the account preference and updates it', () => {
    render(<ParallelWork />);

    const toggle = screen.getByRole('checkbox', { name: 'com_ui_parallel_work' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    expect(preferenceMutation.mutate).toHaveBeenCalledWith(
      { mode: 'parallel' },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(useActiveWorkQuery).not.toHaveBeenCalled();
    expect(screen.queryByText('com_ui_parallel_work_active')).not.toBeInTheDocument();
  });

  test('keeps existing work available elsewhere when its account preference is unavailable', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: { available: false, mode: 'focused' },
      isLoading: false,
      isError: false,
    });

    render(<ParallelWork />);

    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeDisabled();
    expect(screen.getByText('com_ui_parallel_work_toggle_unavailable')).toBeVisible();
    expect(useActiveWorkQuery).not.toHaveBeenCalled();
  });

  test('shows the owner operational blocker without enabling unavailable work', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: {
        available: false,
        mode: 'focused',
        releaseGate: {
          label: 'NOT READY',
          blockers: ['isolation_unavailable'],
        },
      },
      isLoading: false,
      isError: false,
    });

    render(<ParallelWork />);

    expect(screen.getByText('NOT READY')).not.toBeVisible();
    fireEvent.click(screen.getByText('com_ui_additional_details'));
    expect(screen.getByText('NOT READY')).toBeVisible();
    expect(screen.getByText('isolation_unavailable')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeDisabled();
  });

  test('waits for owner readiness before offering a toggle', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    render(<ParallelWork />);

    expect(screen.getByTestId('spinner')).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(preferenceMutation.mutate).not.toHaveBeenCalled();
  });

  test('keeps stale availability disabled when the owner request fails', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: { available: true, mode: 'focused' },
      isLoading: false,
      isError: true,
    });

    render(<ParallelWork />);

    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeDisabled();
    expect(screen.getByText('com_ui_parallel_work_toggle_unavailable')).toBeVisible();
  });

  test.each([false, true])(
    'allows turning saved parallel work off when unavailable (request error: %s)',
    (isError) => {
      (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
        data: { available: false, mode: 'parallel' },
        isLoading: false,
        isError,
      });
      render(<ParallelWork />);
      const toggle = screen.getByRole('checkbox', { name: 'com_ui_parallel_work' });
      expect(toggle).toBeChecked();
      expect(toggle).toBeEnabled();
      fireEvent.click(toggle);
      expect(preferenceMutation.mutate).toHaveBeenCalledWith(
        { mode: 'focused' },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(toggle).toBeDisabled();
    },
  );

  test('keeps an unconfigured owner disabled', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: {
        available: false,
        mode: 'focused',
        releaseGate: { label: 'NOT READY', blockers: ['disabled'] },
      },
      isLoading: false,
      isError: false,
    });

    render(<ParallelWork />);

    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeDisabled();
    expect(screen.getByText('disabled')).toBeInTheDocument();
    expect(screen.getByText('com_ui_parallel_work_installation_disabled')).toBeVisible();
    expect(screen.queryByText('com_ui_parallel_work_toggle_unavailable')).not.toBeInTheDocument();
  });

  test('shows a pending check without presenting a stale snapshot as a failure', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: {
        available: false,
        mode: 'focused',
        releaseGate: { label: 'NOT READY', blockers: ['stale'] },
      },
      isLoading: false,
      isError: false,
    });

    render(<ParallelWork />);

    expect(screen.getByText('com_ui_glasshive_checking')).toBeVisible();
    expect(screen.queryByText('NOT READY')).not.toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeDisabled();
  });
});
