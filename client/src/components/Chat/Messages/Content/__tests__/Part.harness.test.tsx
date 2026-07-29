import React from 'react';
import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import Part from '../Part';

describe('Part harness activity wiring', () => {
  it('renders progress summaries as harness activity instead of hidden model reasoning', () => {
    render(
      <Part
        isSubmitting={true}
        showCursor={false}
        isCreatedByUser={false}
        part={{
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: {
            event: 'started',
            summary: 'The harness started working.\nThe harness used a tool.\n',
          },
        }}
      />,
    );

    expect(screen.getByText('Harness activity')).toBeInTheDocument();
    expect(screen.getByText('The harness started working.')).toBeInTheDocument();
    expect(screen.getByText('The harness used a tool.')).toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });
});
