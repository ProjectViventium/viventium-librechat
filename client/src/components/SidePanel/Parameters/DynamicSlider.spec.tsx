import { render, waitFor } from '@testing-library/react';
import DynamicSlider from './DynamicSlider';

const mockSetInputValue = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useDebouncedInput: () => [mockSetInputValue, '', jest.fn()],
  useParameterEffects: jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ preset: null }),
}));

jest.mock('~/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  defaultTextProps: '',
  optionText: '',
}));

jest.mock('@librechat/client', () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Slider: () => <div data-testid="slider" />,
  HoverCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: () => <input />,
  InputNumber: () => <input />,
}));

jest.mock('./OptionHover', () => () => null);

const baseProps = {
  label: 'Effort',
  defaultValue: '',
  options: ['', 'low', 'medium', 'high'],
  setOption: jest.fn(),
};

describe('DynamicSlider incompatible enum persistence', () => {
  beforeEach(() => {
    mockSetInputValue.mockClear();
  });

  it('does not become a second writer for an ordinary enum slider', async () => {
    render(
      <DynamicSlider
        {...baseProps}
        settingKey="reasoning_effort"
        conversation={{ reasoning_effort: 'max' }}
      />,
    );

    await waitFor(() => expect(mockSetInputValue).not.toHaveBeenCalled());
  });

  it('resets a capability-marked incompatible effort', async () => {
    render(
      <DynamicSlider
        {...baseProps}
        settingKey="effort"
        conversation={{ effort: 'xhigh' }}
        {...({
          viventiumRenderCompatibleEnum: true,
          viventiumResetIncompatible: true,
        } as Record<string, unknown>)}
      />,
    );

    await waitFor(() => expect(mockSetInputValue).toHaveBeenCalledTimes(1));
    expect(mockSetInputValue).toHaveBeenCalledWith('');
  });

  it('does not mutate a read-only capability-marked setting', async () => {
    render(
      <DynamicSlider
        {...baseProps}
        settingKey="effort"
        conversation={{ effort: 'xhigh' }}
        readonly
        {...({
          viventiumRenderCompatibleEnum: true,
          viventiumResetIncompatible: true,
        } as Record<string, unknown>)}
      />,
    );

    await waitFor(() => expect(mockSetInputValue).not.toHaveBeenCalled());
  });

  it('renders a compatible preset value without mutating the saved preset on open', async () => {
    render(
      <DynamicSlider
        {...baseProps}
        settingKey="effort"
        conversation={{ effort: 'xhigh' }}
        {...({ viventiumRenderCompatibleEnum: true } as Record<string, unknown>)}
      />,
    );

    await waitFor(() => expect(mockSetInputValue).not.toHaveBeenCalled());
  });
});
