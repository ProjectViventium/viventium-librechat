'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_APP_SUPPORT_DIR =
  process.env.VIVENTIUM_APP_SUPPORT_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Viventium');

function loadDotenvIfPresent(filePath, override = false) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  dotenv.config({ path: filePath, override });
  return true;
}

function loadLocalRuntimeEnv(rootDir, { appSupportDir = DEFAULT_APP_SUPPORT_DIR } = {}) {
  const loadedPaths = [];
  const candidates = [
    { filePath: path.join(appSupportDir, 'runtime', 'runtime.env'), override: false },
    { filePath: path.join(appSupportDir, 'runtime', 'runtime.local.env'), override: true },
    { filePath: path.join(rootDir, '.env'), override: false },
    { filePath: path.join(rootDir, '.env.local'), override: true },
  ];

  for (const candidate of candidates) {
    if (loadDotenvIfPresent(candidate.filePath, candidate.override)) {
      loadedPaths.push(candidate.filePath);
    }
  }

  return {
    appSupportDir,
    loadedPaths,
  };
}

module.exports = {
  DEFAULT_APP_SUPPORT_DIR,
  loadDotenvIfPresent,
  loadLocalRuntimeEnv,
};
