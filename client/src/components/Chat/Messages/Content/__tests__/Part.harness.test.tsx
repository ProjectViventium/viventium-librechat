import React from 'react';
import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import { RecoilRoot } from 'recoil';
import Part from '../Part';

describe('Part harness activity wiring', () => {
  it('keeps activity rows inside a shared message disclosure without a nested disclosure', () => {
    const { container } = render(
      <RecoilRoot>
        <Part
          isSubmitting={false}
          showCursor={false}
          isCreatedByUser={false}
          harnessActivityGrouped={true}
          part={{
            type: ContentTypes.HARNESS_ACTIVITY,
            harness_activity: { event: 'completed', summary: 'Work completed.' },
          }}
        />
      </RecoilRoot>,
    );
    expect(screen.getByText('Work completed.')).toBeInTheDocument();
    expect(container.querySelector('details')).toBeNull();
  });
  it('renders progress summaries as harness activity instead of hidden model reasoning', () => {
    render(
      <RecoilRoot>
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
        />
      </RecoilRoot>,
    );

    expect(screen.getByText('Harness activity')).toBeInTheDocument();
    expect(screen.getByText('The harness started working.')).toBeInTheDocument();
    expect(screen.getByText('The harness used a tool.')).toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });
});
