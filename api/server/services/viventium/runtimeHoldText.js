const { ContentTypes } = require('librechat-data-provider');

const RUNTIME_HOLD_TEXT_FLAG = 'viventium_runtime_hold';

/**
 * Create a canonical runtime-generated hold text part.
 * This marks deterministic "brewing hold" acknowledgements so downstream state resolvers
 * can distinguish them from substantive assistant content without relying on phrase matching.
 */
function createRuntimeHoldTextPart(text = '') {
  return {
    type: ContentTypes.TEXT,
    text,
    [RUNTIME_HOLD_TEXT_FLAG]: true,
  };
}

function isRuntimeHoldTextPart(part) {
  return (
    part != null &&
    typeof part === 'object' &&
    part.type === ContentTypes.TEXT &&
    part[RUNTIME_HOLD_TEXT_FLAG] === true
  );
}

module.exports = {
  RUNTIME_HOLD_TEXT_FLAG,
  createRuntimeHoldTextPart,
  isRuntimeHoldTextPart,
};
