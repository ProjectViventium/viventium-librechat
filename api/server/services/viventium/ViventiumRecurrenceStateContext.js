'use strict';

/* === VIVENTIUM START === Typed recurrence-state compatibility adapter. */
const { buildTrustedRecurrenceStateCapsule } = require('@librechat/api');
const { getTrustedInteractionContext } = require('./interactionContext');

function buildRecurrenceStateCapsule(req, state) {
  return buildTrustedRecurrenceStateCapsule(getTrustedInteractionContext(req), state);
}

module.exports = { buildRecurrenceStateCapsule };
/* === VIVENTIUM END === */
