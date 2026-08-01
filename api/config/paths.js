const path = require('path');

/* === VIVENTIUM START ===
 * Feature: Isolate uploads for concurrent runtimes sharing one checkout.
 *
 * The Viventium compiler owns this absolute App Support path. Keep LibreChat's
 * upstream checkout-relative default for standalone/non-Viventium use.
 */
const configuredUploadsRoot = process.env.VIVENTIUM_LIBRECHAT_UPLOADS_ROOT;
if (configuredUploadsRoot && !path.isAbsolute(configuredUploadsRoot)) {
  throw new Error('VIVENTIUM_LIBRECHAT_UPLOADS_ROOT must be absolute');
}
const uploads = configuredUploadsRoot
  ? path.resolve(configuredUploadsRoot)
  : path.resolve(__dirname, '..', '..', 'uploads');
/* === VIVENTIUM END === */

module.exports = {
  root: path.resolve(__dirname, '..', '..'),
  uploads,
  clientPath: path.resolve(__dirname, '..', '..', 'client'),
  dist: path.resolve(__dirname, '..', '..', 'client', 'dist'),
  publicPath: path.resolve(__dirname, '..', '..', 'client', 'public'),
  fonts: path.resolve(__dirname, '..', '..', 'client', 'public', 'fonts'),
  assets: path.resolve(__dirname, '..', '..', 'client', 'public', 'assets'),
  imageOutput: path.resolve(__dirname, '..', '..', 'client', 'public', 'images'),
  structuredTools: path.resolve(__dirname, '..', 'app', 'clients', 'tools', 'structured'),
  pluginManifest: path.resolve(__dirname, '..', 'app', 'clients', 'tools', 'manifest.json'),
};
