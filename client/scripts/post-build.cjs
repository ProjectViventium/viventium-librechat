const fs = require('fs-extra');

async function postBuild() {
  try {
    const requiredPaths = ['dist/assets/favicon.svg', 'dist/assets/apple-touch-icon.png', 'dist/robots.txt'];
    for (const path of requiredPaths) {
      const exists = await fs.pathExists(path);
      if (!exists) {
        throw new Error(`Missing expected post-build artifact: ${path}`);
      }
    }
    console.log('✅ Post-build verification completed successfully.');
  } catch (err) {
    console.error('❌ Post-build verification failed:', err);
    process.exit(1);
  }
}

postBuild();
