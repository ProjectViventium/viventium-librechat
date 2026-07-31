import {
  AnthropicEffort,
  EModelEndpoint,
  getAnthropicEffortOptions,
  type SettingDefinition,
} from 'librechat-data-provider';

/* === VIVENTIUM START ===
 * Feature: Capability-filtered Anthropic effort controls.
 * Purpose: Never offer or retain a model parameter the selected model cannot accept.
 * === VIVENTIUM END === */
const ANTHROPIC_EFFORT_ENDPOINTS = new Set<string>([
  EModelEndpoint.anthropic,
  EModelEndpoint.bedrock,
]);

export type ViventiumCompatibleSettingDefinition = SettingDefinition & {
  viventiumRenderCompatibleEnum?: boolean;
  viventiumResetIncompatible?: boolean;
};

export function withModelCompatibleOptions(
  setting: SettingDefinition,
  endpoint: string,
  model: string,
  { persistReset = true }: { persistReset?: boolean } = {},
): ViventiumCompatibleSettingDefinition {
  if (!model || setting.key !== 'effort' || !ANTHROPIC_EFFORT_ENDPOINTS.has(endpoint)) {
    return setting;
  }

  const availableEfforts = new Set(getAnthropicEffortOptions(model));
  const compatibleOptions = setting.options?.filter(
    (option) => option !== AnthropicEffort.xhigh || availableEfforts.has(AnthropicEffort.xhigh),
  );
  if (compatibleOptions == null || compatibleOptions.length === setting.options?.length) {
    return setting;
  }

  return {
    ...setting,
    options: compatibleOptions,
    viventiumRenderCompatibleEnum: true,
    ...(persistReset ? { viventiumResetIncompatible: true } : {}),
  };
}

export function getCompatibleEnumValue(
  options: string[],
  value: unknown,
  defaultValue: unknown,
): string | undefined {
  if (typeof value !== 'string' || options.includes(value)) {
    return typeof value === 'string' ? value : undefined;
  }
  if (typeof defaultValue === 'string' && options.includes(defaultValue)) {
    return defaultValue;
  }
  return options[0];
}
