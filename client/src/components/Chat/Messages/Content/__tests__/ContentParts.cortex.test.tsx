import React from 'react';
import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import ContentParts from '../ContentParts';

jest.mock('../Part', () => ({
  __esModule: true,
  default: ({
    part,
  }: {
    part: { type?: string; text?: string; cortex_name?: string; error?: string };
  }) => <div data-testid={`part-${part.type}`}>{part.text || part.cortex_name || part.error}</div>,
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Web/Sources', () => ({
  __esModule: true,
  default: () => null,
}));

describe('ContentParts cortex fallback text', () => {
  it('renders the saved parent answer text when persisted content is cortex-only', () => {
    render(
      <ContentParts
        content={[
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'confirmation_bias',
            cortex_name: 'Confirmation Bias',
            status: 'complete',
            insight: 'Check assumptions.',
          },
        ]}
        fallbackText="TEST_OK"
        messageId="assistant-parent"
        isCreatedByUser={false}
        isLast={false}
        isSubmitting={false}
      />,
    );

    expect(screen.getByTestId('part-cortex_insight')).toHaveTextContent('Confirmation Bias');
    expect(screen.getByTestId('part-text')).toHaveTextContent('TEST_OK');
  });

  it('does not render an internal no-response marker as fallback text', () => {
    render(
      <ContentParts
        content={[
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'red_team',
            cortex_name: 'Red Team',
            status: 'complete',
            insight: 'No issue.',
          },
        ]}
        fallbackText="{NTA}"
        messageId="assistant-parent"
        isCreatedByUser={false}
        isLast={false}
        isSubmitting={false}
      />,
    );

    expect(screen.getByTestId('part-cortex_insight')).toHaveTextContent('Red Team');
    expect(screen.queryByTestId('part-text')).toBeNull();
  });

  it('renders fallback text and suppresses a late termination error when content has cortex parts', () => {
    render(
      <ContentParts
        content={[
          {
            type: ContentTypes.CORTEX_INSIGHT,
            cortex_id: 'confirmation_bias',
            cortex_name: 'Confirmation Bias',
            status: 'complete',
            insight: 'Check assumptions.',
          },
          {
            type: ContentTypes.ERROR,
            [ContentTypes.ERROR]: 'terminated',
            text: 'terminated',
          },
        ]}
        fallbackText="TEST_OK"
        messageId="assistant-parent"
        isCreatedByUser={false}
        isLast={false}
        isSubmitting={false}
      />,
    );

    expect(screen.getByTestId('part-cortex_insight')).toHaveTextContent('Confirmation Bias');
    expect(screen.getByTestId('part-text')).toHaveTextContent('TEST_OK');
    expect(screen.queryByTestId('part-error')).toBeNull();
  });
});
