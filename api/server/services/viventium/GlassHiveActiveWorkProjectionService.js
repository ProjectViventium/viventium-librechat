/* === VIVENTIUM START ===
 * Feature: Core-owned Active work delivery projection.
 * Purpose: Keep the legacy /api surface as a database adapter while packages/api owns behavior.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createGlassHiveActiveWorkProjectionService } = require('@librechat/api');

const projection = createGlassHiveActiveWorkProjectionService(
  mongoose.connection.collection('viventium_external_work'),
  mongoose.connection.collection('viventium_glasshive_mission_evidence'),
);

module.exports = {
  ...projection,
  async getCoreWorkDelivery(input) {
    const target =
      await require('./NativeCoordinatorWorkService').resolveNativeCoordinatorWorkIdentity(input);
    return projection.getCoreWorkDelivery(
      target ? { ...input, workRef: target.nativeWorkRef } : input,
    );
  },
  async getCoreWorkOriginRef(input) {
    const target =
      await require('./NativeCoordinatorWorkService').resolveNativeCoordinatorWorkIdentity(input);
    return projection.getCoreWorkOriginRef(
      target ? { ...input, workRef: target.nativeWorkRef } : input,
    );
  },
  async enrichActiveWorkSnapshot(input) {
    const snapshot = await require('./NativeCoordinatorService').enrich(
      input.ownerId,
      input.snapshot,
      input.includeCoreOnlyHistory ? 'history' : 'active',
      input.includeCoreOnly === true || input.includeCoreOnlyHistory === true,
    );
    return projection.enrichActiveWorkSnapshot({ ...input, snapshot });
  },
};
