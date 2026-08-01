/* === VIVENTIUM START ===
 * Regression coverage for compiler-owned, per-runtime uploads isolation.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const originalUploadsRoot = process.env.VIVENTIUM_LIBRECHAT_UPLOADS_ROOT;
let testRoot;

function loadPathsWithUploadsRoot(uploadsRoot) {
  if (uploadsRoot == null) {
    delete process.env.VIVENTIUM_LIBRECHAT_UPLOADS_ROOT;
  } else {
    process.env.VIVENTIUM_LIBRECHAT_UPLOADS_ROOT = uploadsRoot;
  }
  jest.resetModules();
  return require('./paths');
}

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-uploads-paths-'));
});

afterEach(() => {
  if (originalUploadsRoot == null) {
    delete process.env.VIVENTIUM_LIBRECHAT_UPLOADS_ROOT;
  } else {
    process.env.VIVENTIUM_LIBRECHAT_UPLOADS_ROOT = originalUploadsRoot;
  }
  jest.resetModules();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('Viventium uploads path isolation', () => {
  it('uses the compiler-owned uploads root instead of the shared checkout', () => {
    const firstRoot = path.join(testRoot, 'runtime-a', 'data', 'uploads');
    const secondRoot = path.join(testRoot, 'runtime-b', 'data', 'uploads');

    const firstPaths = loadPathsWithUploadsRoot(firstRoot);
    const secondPaths = loadPathsWithUploadsRoot(secondRoot);

    expect(firstPaths.uploads).toBe(path.resolve(firstRoot));
    expect(secondPaths.uploads).toBe(path.resolve(secondRoot));
    expect(firstPaths.uploads).not.toBe(secondPaths.uploads);

    fs.mkdirSync(firstPaths.uploads, { recursive: true });
    fs.mkdirSync(secondPaths.uploads, { recursive: true });
    fs.writeFileSync(path.join(firstPaths.uploads, 'runtime-a-only.txt'), 'runtime a\n');
    fs.writeFileSync(path.join(secondPaths.uploads, 'runtime-b-only.txt'), 'runtime b\n');

    expect(fs.existsSync(path.join(firstPaths.uploads, 'runtime-b-only.txt'))).toBe(false);
    expect(fs.existsSync(path.join(secondPaths.uploads, 'runtime-a-only.txt'))).toBe(false);
  });

  it('keeps the upstream checkout-relative default outside Viventium runtimes', () => {
    const paths = loadPathsWithUploadsRoot(undefined);

    expect(paths.uploads).toBe(path.resolve(__dirname, '..', '..', 'uploads'));
  });

  it('rejects an ambiguous relative compiler-owned uploads root', () => {
    expect(() => loadPathsWithUploadsRoot('relative/uploads')).toThrow(
      'VIVENTIUM_LIBRECHAT_UPLOADS_ROOT must be absolute',
    );
  });
});
/* === VIVENTIUM END === */
