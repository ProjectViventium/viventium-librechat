import {
  TOOL_EFFECT_CLASSES,
  isFallbackReplaySafeToolMetadata,
  toolEffectMetadata,
} from './toolEffectMetadata';

describe('toolEffectMetadata', () => {
  it('marks graph coordination and read-only tools as replay safe', () => {
    expect(
      isFallbackReplaySafeToolMetadata(toolEffectMetadata(TOOL_EFFECT_CLASSES.graphCoordination)),
    ).toBe(true);
    expect(isFallbackReplaySafeToolMetadata(toolEffectMetadata(TOOL_EFFECT_CLASSES.readOnly))).toBe(
      true,
    );
  });

  it('fails closed for mutations, missing metadata, and model-controlled lookalikes', () => {
    expect(
      isFallbackReplaySafeToolMetadata(toolEffectMetadata(TOOL_EFFECT_CLASSES.externalMutation)),
    ).toBe(false);
    expect(isFallbackReplaySafeToolMetadata(undefined)).toBe(false);
    expect(
      isFallbackReplaySafeToolMetadata({
        viventiumToolEffectClass: 'viventium.agent.tool.effect.read_only.v1',
      }),
    ).toBe(false);
  });

  it('uses the global symbol registry so thin CommonJS wrappers preserve identity', () => {
    expect(TOOL_EFFECT_CLASSES.readOnly).toBe(
      Symbol.for('viventium.agent.tool.effect.read_only.v1'),
    );
  });
});
