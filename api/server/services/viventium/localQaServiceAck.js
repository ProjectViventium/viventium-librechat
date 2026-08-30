/* === VIVENTIUM START === Thin adapter for typed local-QA service acknowledgement. === VIVENTIUM END === */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { logger } = require('@librechat/data-schemas');
const { createLocalQaServiceAckService } = require('@librechat/api');

const service = createLocalQaServiceAckService({
  fileSystem: fs,
  installedRoot: path.resolve(__dirname, '../../../../../..'),
  log: logger,
  spawn: spawnSync,
});

module.exports = service;
