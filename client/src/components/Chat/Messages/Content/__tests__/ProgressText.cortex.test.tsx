import React from 'react';
import { render, screen } from '@testing-library/react';
import CancelledIcon from '../CancelledIcon';
import CortexCall from '../CortexCall';
import ProgressText from '../ProgressText';

jest.mock('@librechat/client', () => ({
  Spinner: ({ className }: { className?: string }) => (
    <span data-testid="spinner" className={className} />
  ),
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) =>
    classes
      .flat()
      .filter(
        (className): className is string => typeof className === 'string' && className.length > 0,
      )
      .join(' '),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

describe('ProgressText and background cortex status layout', () => {
  beforeAll(() => {
    if (typeof global.ResizeObserver === 'undefined') {
      global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    }
  });

  it('keeps the cancelled icon fixed-size inside full-width progress rows', () => {
    const { container } = render(<CancelledIcon />);
    const iconRoot = container.firstElementChild;

    expect(iconRoot).toHaveClass('size-4');
    expect(iconRoot).toHaveClass('shrink-0');
    expect(iconRoot).not.toHaveClass('h-full');
    expect(iconRoot).not.toHaveClass('w-full');
  });

  it('renders cancelled ProgressText without a width-stretching icon wrapper', () => {
    const { container } = render(
      <ProgressText
        progress={0.2}
        inProgressText="Checking Background..."
        finishedText="Checking Background..."
        error={true}
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Checking Background...');
    const iconSlot = container.querySelector('.progress-text-icon');
    const iconRoot = container.querySelector('.progress-text-icon > div');
    expect(iconSlot).toHaveClass('size-5');
    expect(iconSlot).toHaveClass('shrink-0');
    expect(iconRoot).toHaveClass('size-4');
    expect(iconRoot).toHaveClass('shrink-0');
    expect(iconRoot).not.toHaveClass('w-full');
  });

  it('does not mark an active background cortex cancelled after the main response finishes', () => {
    render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background"
        status="activating"
        reason="Relevant background check"
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Checking Background...');
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('does not mark a brewing background cortex cancelled after the main response finishes', () => {
    render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background"
        status="brewing"
        reason="Relevant background check"
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Analyzing with Background...');
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('hides terminal no-response cortex completions instead of leaving a brewing row', () => {
    const { container } = render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background"
        status="complete"
        insight=""
        silent={true}
        no_response={true}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Insight from Background')).not.toBeInTheDocument();
  });

  it('still renders true cortex errors with the fixed-size cancelled icon', () => {
    const { container } = render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background"
        status="error"
        reason="The background check failed"
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Background error');
    const iconSlot = container.querySelector('.progress-text-icon');
    const iconRoot = container.querySelector('.progress-text-icon > div');
    expect(iconSlot).toHaveClass('size-5');
    expect(iconSlot).toHaveClass('shrink-0');
    expect(iconRoot).toHaveClass('size-4');
    expect(iconRoot).toHaveClass('shrink-0');
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
  });
});
