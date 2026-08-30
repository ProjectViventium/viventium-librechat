/* === VIVENTIUM START === Typed rapid-source compatibility adapter. */
const { buildTrustedSourceSelectionCapsule } = require('@librechat/api');
const {
  getTrustedAdapterCapabilities,
  getTrustedInteractionContext,
} = require('./interactionContext');

function buildSourceSelectionCapsule(req) {
  return buildTrustedSourceSelectionCapsule(
    getTrustedInteractionContext(req),
    getTrustedAdapterCapabilities(req),
  );
}

module.exports = { buildSourceSelectionCapsule };
/* === VIVENTIUM END === */
