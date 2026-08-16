import React from 'react';
import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import Part from '../Part';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key) =>
    ({
      com_ui_harness_activity: 'Localized harness activity',
      com_ui_model_fallback_used: 'Localized model fallback used',
    })[key] ?? key,
}));

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

    expect(screen.getByText('Localized harness activity').closest('details')).toHaveAttribute(
      'data-viventium-harness-activity',
      'true',
    );
    expect(screen.getByText('The harness started working.')).toBeInTheDocument();
    expect(screen.getByText('The harness used a tool.')).toBeInTheDocument();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it('renders successful fallback recovery as visible model-routing disclosure', () => {
    render(
      <Part
        isSubmitting={false}
        showCursor={false}
        isCreatedByUser={false}
        part={{
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: {
            event: 'fallback-recovery',
            summary: 'The primary model route was unavailable. The fallback completed.',
          },
        }}
      />,
    );

    expect(screen.getByText('Localized model fallback used')).toBeInTheDocument();
    expect(screen.getByText(/primary model route was unavailable/i)).toBeInTheDocument();
  });
});
