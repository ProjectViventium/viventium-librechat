import { AnthropicEffort, EModelEndpoint } from 'librechat-data-provider';
import { getCompatibleEnumValue, withModelCompatibleOptions } from './modelCapabilities';

const effortSetting = {
  key: 'effort',
  type: 'enum' as const,
  component: 'slider' as const,
  options: [
    AnthropicEffort.unset,
    AnthropicEffort.low,
    AnthropicEffort.medium,
    AnthropicEffort.high,
    AnthropicEffort.xhigh,
    AnthropicEffort.max,
  ],
};

describe('model-compatible parameter options', () => {
  it.each([EModelEndpoint.anthropic, EModelEndpoint.bedrock])(
    'hides xhigh for unsupported %s models',
    (endpoint) => {
      const result = withModelCompatibleOptions(effortSetting, endpoint, 'claude-opus-4-6');
      expect(result.options).not.toContain(AnthropicEffort.xhigh);
    },
  );

  it.each(['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'])(
    'keeps xhigh for supported model %s',
    (model) => {
      const result = withModelCompatibleOptions(effortSetting, EModelEndpoint.anthropic, model);
      expect(result.options).toContain(AnthropicEffort.xhigh);
    },
  );

  it('does not change another provider effort definition', () => {
    expect(withModelCompatibleOptions(effortSetting, EModelEndpoint.openAI, 'gpt-5.6')).toBe(
      effortSetting,
    );
  });

  it('does not filter or mark options while the model is unresolved', () => {
    expect(withModelCompatibleOptions(effortSetting, EModelEndpoint.anthropic, '')).toBe(
      effortSetting,
    );
  });

  it('marks only a filtered Anthropic effort setting for incompatible-value reset', () => {
    expect(
      withModelCompatibleOptions(effortSetting, EModelEndpoint.anthropic, 'claude-opus-4-6'),
    ).toMatchObject({
      viventiumResetIncompatible: true,
    });
    expect(
      withModelCompatibleOptions(effortSetting, EModelEndpoint.anthropic, 'claude-opus-5'),
    ).not.toHaveProperty('viventiumResetIncompatible');
  });

  it('filters a preset picker without mutating the preset on open', () => {
    expect(
      withModelCompatibleOptions(effortSetting, EModelEndpoint.anthropic, 'claude-opus-4-6', {
        persistReset: false,
      }),
    ).toMatchObject({
      viventiumRenderCompatibleEnum: true,
      options: [
        AnthropicEffort.unset,
        AnthropicEffort.low,
        AnthropicEffort.medium,
        AnthropicEffort.high,
        AnthropicEffort.max,
      ],
    });
    expect(
      withModelCompatibleOptions(effortSetting, EModelEndpoint.anthropic, 'claude-opus-4-6', {
        persistReset: false,
      }),
    ).not.toHaveProperty('viventiumResetIncompatible');
  });
});

describe('getCompatibleEnumValue', () => {
  it('replaces an incompatible persisted choice with the declared default', () => {
    expect(
      getCompatibleEnumValue(
        [AnthropicEffort.unset, AnthropicEffort.high, AnthropicEffort.max],
        AnthropicEffort.xhigh,
        AnthropicEffort.unset,
      ),
    ).toBe(AnthropicEffort.unset);
  });

  it('preserves a compatible persisted choice', () => {
    expect(
      getCompatibleEnumValue(
        [AnthropicEffort.unset, AnthropicEffort.high, AnthropicEffort.xhigh],
        AnthropicEffort.xhigh,
        AnthropicEffort.unset,
      ),
    ).toBe(AnthropicEffort.xhigh);
  });
});
