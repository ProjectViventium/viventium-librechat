/* === VIVENTIUM START ===
 * Feature: Core-owned Active work delivery projection.
 * Purpose: Keep the legacy /api surface as a database adapter while packages/api owns behavior.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createGlassHiveActiveWorkProjectionService } = require('@librechat/api');

module.exports = createGlassHiveActiveWorkProjectionService(
  mongoose.connection.collection('viventium_external_work'),
);
