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

  test('keeps unavailable configuration dark without querying the preference', () => {
    render(<ParallelWork featureAvailable={false} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(useOrchestrationPreferenceQuery).not.toHaveBeenCalled();
    expect(useActiveWorkQuery).not.toHaveBeenCalled();
  });

  test('shows only the account preference and updates it', () => {
    render(<ParallelWork featureAvailable />);

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

    render(<ParallelWork featureAvailable />);

    expect(screen.getByRole('checkbox', { name: 'com_ui_parallel_work' })).toBeDisabled();
    expect(screen.getByText('com_ui_parallel_work_toggle_unavailable')).toBeVisible();
    expect(useActiveWorkQuery).not.toHaveBeenCalled();
  });

  test('shows the compiled pre-gate label and blockers during local QA exposure', () => {
    (useOrchestrationPreferenceQuery as jest.Mock).mockReturnValue({
      data: {
        available: true,
        mode: 'parallel',
        releaseGate: {
          label: 'PRE-GATE / NOT READY',
          blockers: ['PWK-UC-014', 'STORAGE-PRESSURE'],
        },
      },
      isLoading: false,
      isError: false,
    });

    render(<ParallelWork featureAvailable />);

    expect(screen.getByText('PRE-GATE / NOT READY')).toBeVisible();
    expect(screen.getByText('PWK-UC-014, STORAGE-PRESSURE')).toBeVisible();
  });
});
