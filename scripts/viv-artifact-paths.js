#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Purpose: Single-source artifact path helper for Viventium sync/backup scripts.
 * Why: Keep exports/backups/snapshots in one consistent timestamped tree for easier handoff/operations.
 * Scope: Local script runtime only; no upstream LibreChat behavior changes.
 * === VIVENTIUM END === */
'use strict';

const fs = require('fs');
const path = require('path');

function sanitizeSlug(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'run';
}

function utcTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function resolveArtifactsRoot({ coreDir }) {
  const explicit = process.env.VIVENTIUM_ARTIFACTS_DIR;
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  return path.resolve(coreDir, '.viventium', 'artifacts');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function categoryRoot(artifactsRoot, category) {
  return path.join(artifactsRoot, category);
}

function runsRoot(artifactsRoot, category) {
  return path.join(categoryRoot(artifactsRoot, category), 'runs');
}

function latestPointerPath(artifactsRoot, category) {
  return path.join(categoryRoot(artifactsRoot, category), 'LATEST_PATH');
}

function buildRunDir({ artifactsRoot, category, label }) {
  const timestamp = utcTimestamp();
  const suffix = label ? `-${sanitizeSlug(label)}` : '';
  return path.join(runsRoot(artifactsRoot, category), `${timestamp}${suffix}`);
}

function setLatestRun({ artifactsRoot, category, runDir }) {
  const resolved = path.resolve(runDir);
  ensureDir(categoryRoot(artifactsRoot, category));
  fs.writeFileSync(latestPointerPath(artifactsRoot, category), `${resolved}\n`);
}

function getLatestRun({ artifactsRoot, category }) {
  const pointer = latestPointerPath(artifactsRoot, category);
  if (!fs.existsSync(pointer)) {
    return null;
  }
  const raw = fs.readFileSync(pointer, 'utf8').trim();
  if (!raw) {
    return null;
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return null;
  }
  return resolved;
}

module.exports = {
  buildRunDir,
  ensureDir,
  getLatestRun,
  resolveArtifactsRoot,
  sanitizeSlug,
  setLatestRun,
  utcTimestamp,
};
