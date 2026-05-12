import React from 'react';
import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import Part from '../Part';

jest.mock('../CortexCall', () => ({
  __esModule: true,
  default: (props: { cortex_name: string; error?: string; error_class?: string }) => (
    <div
      data-testid="cortex-call"
      data-error={props.error ?? ''}
      data-error-class={props.error_class ?? ''}
    >
      {props.cortex_name}
    </div>
  ),
}));

describe('Part cortex message wiring', () => {
  it('passes terminal cortex error details through to the cortex card renderer', () => {
    render(
      <Part
        isSubmitting={false}
        showCursor={false}
        isCreatedByUser={false}
        part={{
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'background',
          cortex_name: 'Background Analysis',
          status: 'error',
          reason: 'The background check failed',
          error: 'Provider authentication failed: missing required model scope',
          error_class: 'provider_unauthorized',
        }}
      />,
    );

    expect(screen.getByTestId('cortex-call')).toHaveAttribute(
      'data-error',
      'Provider authentication failed: missing required model scope',
    );
    expect(screen.getByTestId('cortex-call')).toHaveAttribute(
      'data-error-class',
      'provider_unauthorized',
    );
  });
});
