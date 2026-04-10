import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import { getCustomEndpointConfig } from '~/app/config';
import { getProviderConfig, providerConfigMap } from './config';

jest.mock('~/app/config', () => ({
  getCustomEndpointConfig: jest.fn(),
}));

describe('getProviderConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts the compiler-emitted lowercase openai provider', () => {
    const result = getProviderConfig({ provider: 'openai' });

    expect(result.overrideProvider).toBe(EModelEndpoint.openAI);
    expect(result.getOptions).toBe(providerConfigMap[EModelEndpoint.openAI]);
  });

  it('keeps canonical provider input idempotent', () => {
    const result = getProviderConfig({ provider: EModelEndpoint.openAI });

    expect(result.overrideProvider).toBe(EModelEndpoint.openAI);
    expect(result.getOptions).toBe(providerConfigMap[EModelEndpoint.openAI]);
  });

  it('normalizes mixed-case custom providers before endpoint-config lookup', () => {
    (getCustomEndpointConfig as jest.Mock).mockReturnValue({ name: Providers.OPENROUTER });

    const result = getProviderConfig({ provider: 'OpenRouter', appConfig: {} as never });

    expect(result.overrideProvider).toBe(Providers.OPENROUTER);
    expect(result.initEndpoint).toBe(Providers.OPENROUTER);
    expect(getCustomEndpointConfig).toHaveBeenCalledWith({
      endpoint: Providers.OPENROUTER,
      appConfig: {},
    });
    expect(result.customEndpointConfig).toEqual({ name: Providers.OPENROUTER });
  });

  it('preserves the custom endpoint name for arbitrary OpenAI-compatible providers', () => {
    (getCustomEndpointConfig as jest.Mock).mockReturnValue({ name: 'mlx' });

    const result = getProviderConfig({ provider: 'MLX', appConfig: {} as never });

    expect(result.overrideProvider).toBe(Providers.OPENAI);
    expect(result.initEndpoint).toBe('mlx');
    expect(getCustomEndpointConfig).toHaveBeenCalledWith({
      endpoint: 'MLX',
      appConfig: {},
    });
  });
});
