import React from 'react';
import { render } from '@testing-library/react';
import FallbackLlmPanel from '../FallbackLlmPanel';

let capturedProps: Record<string, unknown> | undefined;

jest.mock('../OptionalLlmPanel', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    capturedProps = props;
    return <div data-testid="optional-llm-panel" />;
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('FallbackLlmPanel', () => {
  it('passes provider capability metadata to the fallback route controls', () => {
    const providerCapabilities = {
      'glasshive-harness': {
        workspace_binding: true,
        models: [
          {
            id: 'claude-code:opus',
            label: 'Claude / Opus 5',
            effortChoices: ['low', 'medium', 'high'],
            recommendedEffort: 'high',
          },
        ],
      },
    };

    const Component = FallbackLlmPanel as React.ComponentType<Record<string, unknown>>;
    render(
      <Component
        models={{ 'glasshive-harness': ['claude-code:opus'] }}
        providers={[{ value: 'glasshive-harness', label: 'GlassHive' }]}
        providerCapabilities={providerCapabilities}
        setActivePanel={jest.fn()}
      />,
    );

    expect(capturedProps?.providerCapabilities).toBe(providerCapabilities);
  });
});
