/* === VIVENTIUM START ===
 * Feature: Structural tool-effect metadata for provider fallback.
 * Purpose: A provider retry may safely repeat only server-declared non-effecting work. Symbols keep
 * the declaration on the registered tool object, outside model-controlled names and arguments.
 * Unknown tools remain fail-closed.
 * Added: 2026-08-18
 */

export const TOOL_EFFECT_CLASSES = Object.freeze({
  graphCoordination: Symbol.for('viventium.agent.graph.coordination.effect.token.v1'),
  readOnly: Symbol.for('viventium.agent.tool.effect.read_only.v1'),
  externalMutation: Symbol.for('viventium.agent.tool.effect.external_mutation.v1'),
});

export type ToolEffectClass = (typeof TOOL_EFFECT_CLASSES)[keyof typeof TOOL_EFFECT_CLASSES];

export interface ToolEffectMetadata extends Record<string, unknown> {
  viventiumToolEffectClass: ToolEffectClass;
}

export function toolEffectMetadata(effectClass: ToolEffectClass): ToolEffectMetadata {
  return { viventiumToolEffectClass: effectClass };
}

export function isFallbackReplaySafeToolMetadata(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) {
    return false;
  }

  const effectClass = Reflect.get(metadata, 'viventiumToolEffectClass');
  return (
    effectClass === TOOL_EFFECT_CLASSES.graphCoordination ||
    effectClass === TOOL_EFFECT_CLASSES.readOnly
  );
}

/* === VIVENTIUM END === */
