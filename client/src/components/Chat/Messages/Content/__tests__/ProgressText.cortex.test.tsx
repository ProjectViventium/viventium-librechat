import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
        cortex_name="Background Analysis"
        status="activating"
        reason="Relevant background check"
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Checking Background Analysis...');
    expect(screen.getByText(/Background Analysis/)).toBeInTheDocument();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('does not mark a brewing background cortex cancelled after the main response finishes', () => {
    render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background Analysis"
        status="brewing"
        reason="Relevant background check"
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Analyzing with Background Analysis...');
    expect(screen.getByText(/Background Analysis/)).toBeInTheDocument();
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
    expect(screen.queryByText(/Additional thought/)).not.toBeInTheDocument();
  });

  it('hides terminal no-response cortex completions even when an activation reason is preserved', () => {
    const { container } = render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background"
        status="complete"
        reason="It was considered relevant before the cortex returned no response"
        insight=""
        silent={true}
        no_response={true}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Additional thought/)).not.toBeInTheDocument();
    expect(screen.queryByText(/considered relevant/)).not.toBeInTheDocument();
  });

  it('still renders true cortex errors with the fixed-size cancelled icon', () => {
    const { container } = render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background Analysis"
        status="error"
        reason="The background check failed"
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Background Analysis error');
    expect(screen.getByText(/Background Analysis/)).toBeInTheDocument();
    const iconSlot = container.querySelector('.progress-text-icon');
    const iconRoot = container.querySelector('.progress-text-icon > div');
    expect(iconSlot).toHaveClass('size-5');
    expect(iconSlot).toHaveClass('shrink-0');
    expect(iconRoot).toHaveClass('size-4');
    expect(iconRoot).toHaveClass('shrink-0');
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
  });

  it('renders terminal cortex error details in the expanded card', () => {
    render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background Analysis"
        status="error"
        reason="The background check failed"
        error="Provider authentication failed: missing required model scope"
        error_class="provider_unauthorized"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Error from Background Analysis')).toBeInTheDocument();
    expect(
      screen.getByText('Provider authentication failed: missing required model scope'),
    ).toBeInTheDocument();
    expect(screen.getByText('Issue type: Provider authentication issue')).toBeInTheDocument();
    expect(screen.getByText('Error occurred')).toBeInTheDocument();
  });

  it('sanitizes private terminal cortex error details in the expanded card', () => {
    const privateEmail = ['user', 'example.com'].join('@');
    const privatePath = '/' + ['Users', 'example', 'project'].join('/');
    const bearerSecret = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
    render(
      <CortexCall
        cortex_id="background"
        cortex_name="Background Analysis"
        status="error"
        reason="The background check failed"
        error={`Provider failed for ${privateEmail} at ${privatePath} with ${bearerSecret}`}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(
      screen.getByText(
        'This background agent hit a runtime issue before it could return a result.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(privatePath)).not.toBeInTheDocument();
    expect(screen.queryByText(privateEmail)).not.toBeInTheDocument();
    expect(screen.queryByText(/abcdefghijklmnopqrstuvwxyz/)).not.toBeInTheDocument();
  });

  it('renders completed cortex insights with the activated cortex name visible', () => {
    render(
      <CortexCall
        cortex_id="confirmation_bias"
        cortex_name="Confirmation Bias"
        status="complete"
        reason="Relevant background check"
        insight="This adds a genuinely new thought."
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Confirmation Bias');
    expect(screen.queryByText(/Additional thought/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Insight from Confirmation Bias/)).not.toBeInTheDocument();
    expect(screen.getByText(/Confirmation Bias/)).toBeInTheDocument();
  });
});
