/* === VIVENTIUM START ===
 * Feature: Structural tool-effect metadata for provider fallback.
 * Purpose: A provider retry may safely repeat only server-declared non-effecting work. Symbols keep
 * the declaration on the registered tool object, outside model-controlled names and arguments.
 * Unknown tools remain fail-closed.
 * Added: 2026-08-18
 */

const TOOL_EFFECT_CLASSES = Object.freeze({
  graphCoordination: Symbol.for('viventium.agent.graph.coordination.effect.token.v1'),
  readOnly: Symbol.for('viventium.agent.tool.effect.read_only.v1'),
  externalMutation: Symbol.for('viventium.agent.tool.effect.external_mutation.v1'),
});

function toolEffectMetadata(effectClass) {
  return { viventiumToolEffectClass: effectClass };
}

function isFallbackReplaySafeToolMetadata(metadata) {
  const effectClass = metadata?.viventiumToolEffectClass;
  return (
    effectClass === TOOL_EFFECT_CLASSES.graphCoordination ||
    effectClass === TOOL_EFFECT_CLASSES.readOnly
  );
}

module.exports = {
  TOOL_EFFECT_CLASSES,
  toolEffectMetadata,
  isFallbackReplaySafeToolMetadata,
};

/* === VIVENTIUM END === */
