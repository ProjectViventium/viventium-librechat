import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { createRequire } from 'module';
import { VitePWA } from 'vite-plugin-pwa';
import { compression } from 'vite-plugin-compression2';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import type { Plugin } from 'vite';
import { resolveAllowedHosts, resolveBackendUrl, type RuntimeEnv } from './src/utils/devProxy';

const require = createRequire(import.meta.url);

/**
 * vite-plugin-node-polyfills uses @rollup/plugin-inject to replace bare globals (e.g. `process`)
 * with imports like `import process from 'vite-plugin-node-polyfills/shims/process'`. When the
 * consuming module (e.g. recoil) is hoisted to the monorepo root, Vite 7's ESM resolver walks up
 * from there and never finds the shims (installed only in client/node_modules). This map resolves
 * the shim specifiers to absolute paths via CJS require.resolve anchored to the client directory.
 */
const NODE_POLYFILL_SHIMS: Record<string, string> = {
  'vite-plugin-node-polyfills/shims/process': require.resolve(
    'vite-plugin-node-polyfills/shims/process',
  ),
  'vite-plugin-node-polyfills/shims/buffer': require.resolve(
    'vite-plugin-node-polyfills/shims/buffer',
  ),
  'vite-plugin-node-polyfills/shims/global': require.resolve(
    'vite-plugin-node-polyfills/shims/global',
  ),
};

/* === VIVENTIUM START ===
 * Feature: Browser-only dependency adapters and compiled compliance inventory.
 *
 * sandpack-react imports the aggregate sandpack-client entry, whose template switch makes Rollup
 * retain the Node client and @codesandbox/nodebox even though Viventium only creates static and
 * browser-runtime artifacts. Route that exact aggregate import through a browser-only adapter.
 * Static artifacts also use SandpackRuntime: the published static-browser-server package omits the
 * license file declared by its package metadata, so it cannot satisfy Viventium's fail-closed
 * shipped-notice gate. A package upgrade must review whether that upstream defect has been fixed.
 * Small compatibility adapters also preserve the browser contracts of transitive packages whose
 * published tarballs have no exact legal text, without redistributing those package bytes.
 */
const SANDPACK_BROWSER_ADAPTER = path.resolve(__dirname, 'src/utils/sandpackClientAdapter.ts');
const SANDPACK_COMPLIANCE_DIRECTORY = path.resolve(__dirname, 'dist-compliance');
const HTML_AST_ADAPTER = path.resolve(__dirname, 'src/utils/htmlAstAdapter.ts');
const NATIVE_INTERSECTION_OBSERVER = path.resolve(
  __dirname,
  'src/utils/nativeIntersectionObserver.ts',
);
const SCROLL_BAR_ADAPTER = path.resolve(__dirname, 'src/utils/scrollBarAdapter.tsx');
const USE_COMPOSED_REF_ADAPTER = path.resolve(__dirname, 'src/utils/useComposedRefAdapter.ts');
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Launcher-aware frontend proxy target resolution.
 *
 * Root causes:
 * - 2026-03-11: `viventium-librechat-start.sh` exported `DOMAIN_SERVER=http://localhost:3180`
 *   and wrote the same source-of-truth into `.env`, but Vite config only consulted
 *   `process.env`. In direct/local starts where `BACKEND_PORT` was not explicitly exported,
 *   the frontend stayed on `3190` while `/api/*` proxied to legacy `3080`, yielding dev-proxy
 *   500s.
 * - 2026-04-04: remote-access modes deliberately changed `DOMAIN_SERVER` to the public browser
 *   API origin. Reusing that public HTTPS URL as the local Vite proxy target caused the frontend
 *   dev server to proxy back into the public Caddy endpoint instead of the local backend.
 *
 * Approach:
 * - Load the same env files Vite serves with (`envDir: ../`) before computing proxy targets.
 * - Separate the browser-facing `DOMAIN_SERVER` from the local dev proxy target.
 * - Prefer an explicit local proxy target, then explicit local ports, and only fall back to
 *   `DOMAIN_SERVER` when no local backend target is available.
 * - Preserve the IPv6/bind-all guardrails from the earlier proxy hardening.
 */
function resolveFrontendPort(env: RuntimeEnv) {
  return (
    Number(env.VIVENTIUM_LC_FRONTEND_PORT || env.FRONTEND_PORT || env.VITE_PORT) || 3090
  );
}
/* === VIVENTIUM END === */

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const envDir = path.resolve(__dirname, '..');
  const runtimeEnv = {
    ...loadEnv(mode, envDir, ''),
    ...process.env,
  } as RuntimeEnv;
  const backendURL = resolveBackendUrl(runtimeEnv);

  return {
    base: '',
    server: {
      allowedHosts: resolveAllowedHosts(runtimeEnv),
      host: runtimeEnv.HOST || 'localhost',
      port: resolveFrontendPort(runtimeEnv),
      strictPort: false,
      proxy: {
        '/api': {
          target: backendURL,
          changeOrigin: true,
        },
        '/oauth': {
          target: backendURL,
          changeOrigin: true,
        },
      },
    },
    // Set the directory where environment variables are loaded from and restrict prefixes
    envDir: '../',
    envPrefix: ['VITE_', 'SCRIPT_', 'DOMAIN_', 'ALLOW_'],
    plugins: [
      react(),
      {
        name: 'node-polyfills-shims-resolver',
        resolveId(id) {
          return NODE_POLYFILL_SHIMS[id] ?? null;
        },
      },
      nodePolyfills(),
      VitePWA({
        injectRegister: 'auto', // 'auto' | 'manual' | 'disabled'
        registerType: 'autoUpdate', // 'prompt' | 'autoUpdate'
        devOptions: {
          enabled: false, // disable service worker registration in development mode
        },
        useCredentials: true,
        includeManifestIcons: false,
        /* === VIVENTIUM START ===
         * Feature: Replace LibreChat PWA branding/assets with Viventium icons + manifest data
         *
         * Purpose:
         * - Ensure the client builds a Viventium-branded PWA (manifest + cached assets).
         *
         * Why:
         * - Upstream defaults reference LibreChat asset names; Viventium uses its own icons/manifest files.
         *
         * Details: docs/requirements_and_learnings/16_Branding_and_Assets.md#librechat-vite-pwa
         * Added: 2026-01-26
         */
        workbox: {
          globPatterns: [
            '**/*.{js,css,html}',
            'assets/favicon*.png',
            'assets/favicon*.svg',
            'assets/favicon*.ico',
            'assets/apple-touch-icon*.png',
            'assets/web-app-manifest-*.png',
            'assets/site.webmanifest',
            'manifest.webmanifest',
          ],
          globIgnores: ['images/**/*', '**/*.map', 'index.html'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallbackDenylist: [/^\/oauth/, /^\/api/],
        },
        includeAssets: [],
        manifest: {
          name: 'Viventium',
          short_name: 'Viventium',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          id: '/',
          prefer_related_applications: false,
          background_color: '#ffffff',
          theme_color: '#ffffff',
          icons: [
            {
              src: 'assets/web-app-manifest-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: 'assets/web-app-manifest-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        /* === VIVENTIUM END === */
      }),
      sourcemapExclude({ excludeNodeModules: true }),
      compression({
        threshold: 10240,
      }),
      browserModuleClosure(),
    ],
    publicDir: './public',
    build: {
      sourcemap: runtimeEnv.NODE_ENV === 'development',
      outDir: './dist',
      minify: 'terser',
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        output: {
          manualChunks(id: string) {
            const normalizedId = id.replace(/\\/g, '/');
            if (normalizedId.includes('node_modules')) {
              // High-impact chunking for large libraries

              // IMPORTANT: mermaid and ALL its dependencies must be in the same chunk
              // to avoid initialization order issues. This includes chevrotain, langium,
              // dagre-d3-es, and their nested lodash-es dependencies.
              if (
                normalizedId.includes('mermaid') ||
                normalizedId.includes('dagre-d3-es') ||
                normalizedId.includes('chevrotain') ||
                normalizedId.includes('langium') ||
                normalizedId.includes('lodash-es')
              ) {
                return 'mermaid';
              }

              if (normalizedId.includes('@codesandbox/sandpack')) {
                return 'sandpack';
              }
              if (normalizedId.includes('react-virtualized')) {
                return 'virtualization';
              }
              if (normalizedId.includes('i18next') || normalizedId.includes('react-i18next')) {
                return 'i18n';
              }
              // Only regular lodash (not lodash-es which goes to mermaid chunk)
              if (normalizedId.includes('/lodash/')) {
                return 'utilities';
              }
              if (normalizedId.includes('date-fns')) {
                return 'date-utils';
              }
              if (normalizedId.includes('@dicebear')) {
                return 'avatars';
              }
              if (
                normalizedId.includes('react-dnd') ||
                normalizedId.includes('dnd-core') ||
                normalizedId.includes('react-flip-toolkit') ||
                normalizedId.includes('flip-toolkit')
              ) {
                return 'react-interactions';
              }
              if (normalizedId.includes('react-hook-form')) {
                return 'forms';
              }
              if (normalizedId.includes('react-router-dom')) {
                return 'routing';
              }
              if (
                normalizedId.includes('qrcode.react') ||
                normalizedId.includes('@marsidev/react-turnstile')
              ) {
                return 'security-ui';
              }

              if (normalizedId.includes('@codemirror/view')) {
                return 'codemirror-view';
              }
              if (normalizedId.includes('@codemirror/state')) {
                return 'codemirror-state';
              }
              if (normalizedId.includes('@codemirror/language')) {
                return 'codemirror-language';
              }
              if (normalizedId.includes('@codemirror')) {
                return 'codemirror-core';
              }

              if (
                normalizedId.includes('react-markdown') ||
                normalizedId.includes('remark-') ||
                normalizedId.includes('rehype-')
              ) {
                return 'markdown-processing';
              }
              if (
                normalizedId.includes('monaco-editor') ||
                normalizedId.includes('@monaco-editor')
              ) {
                return 'code-editor';
              }
              if (normalizedId.includes('react-window') || normalizedId.includes('react-virtual')) {
                return 'virtualization';
              }
              if (
                normalizedId.includes('zod') ||
                normalizedId.includes('yup') ||
                normalizedId.includes('joi')
              ) {
                return 'validation';
              }
              if (
                normalizedId.includes('axios') ||
                normalizedId.includes('ky') ||
                normalizedId.includes('fetch')
              ) {
                return 'http-client';
              }
              if (
                normalizedId.includes('react-spring') ||
                normalizedId.includes('react-transition-group')
              ) {
                return 'animations';
              }
              if (normalizedId.includes('react-select') || normalizedId.includes('downshift')) {
                return 'advanced-inputs';
              }
              // Existing chunks
              if (normalizedId.includes('@radix-ui')) {
                return 'radix-ui';
              }
              if (normalizedId.includes('framer-motion')) {
                return 'framer-motion';
              }
              if (
                normalizedId.includes('node_modules/highlight.js') ||
                normalizedId.includes('node_modules/lowlight')
              ) {
                return 'markdown_highlight';
              }
              if (normalizedId.includes('katex') || normalizedId.includes('node_modules/katex')) {
                return 'math-katex';
              }
              if (normalizedId.includes('node_modules/hast-util-raw')) {
                return 'markdown_large';
              }
              if (normalizedId.includes('@tanstack')) {
                return 'tanstack-vendor';
              }
              if (normalizedId.includes('@headlessui')) {
                return 'headlessui';
              }

              // Everything else falls into a generic vendor chunk.
              return 'vendor';
            }
            // Create a separate chunk for all locale files under src/locales.
            if (normalizedId.includes('/src/locales/')) {
              return 'locales';
            }
            // Let Rollup decide automatically for any other files.
            return null;
          },
          entryFileNames: 'assets/[name].[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.names?.[0] && /\.(woff|woff2|eot|ttf|otf)$/.test(assetInfo.names[0])) {
              return 'assets/fonts/[name][extname]';
            }
            return 'assets/[name].[hash][extname]';
          },
        },
        /**
         * Ignore "use client" warning since we are not using SSR
         * @see {@link https://github.com/TanStack/query/pull/5161#issuecomment-1477389761 Preserve 'use client' directives TanStack/query#5161}
         */
        onwarn(warning, warn) {
          if (warning.message.includes('Error when using sourcemap')) {
            return;
          }
          if (
            warning.message.includes('Use of eval in "../node_modules/vm-browserify/index.js"') ||
            warning.message.includes(
              'Module level directives cause errors when bundled, "no babel-plugin-flow-react-proptypes"',
            )
          ) {
            return;
          }
          warn(warning);
        },
      },
      // Viventium intentionally ships a large offline-capable local app bundle.
      // Keep chunk splitting enabled, but avoid noisy warnings until deeper lazy-loading work lands.
      chunkSizeWarningLimit: 4000,
    },
    resolve: {
      alias: [
        /* === VIVENTIUM START ===
         * The exact alias intentionally leaves the official runtime and other Sandpack subpaths
         * untouched. The adapter rejects `node` and imports only the browser runtime client.
         */
        {
          find: /^@codesandbox\/sandpack-client$/,
          replacement: SANDPACK_BROWSER_ADAPTER,
        },
        /* Project-owned implementations of the narrow browser contracts used by upstream. */
        {
          find: /^html-parse-stringify$/,
          replacement: HTML_AST_ADAPTER,
        },
        {
          find: /^intersection-observer$/,
          replacement: NATIVE_INTERSECTION_OBSERVER,
        },
        {
          find: /^react-remove-scroll-bar(?:\/constants)?$/,
          replacement: SCROLL_BAR_ADAPTER,
        },
        {
          find: /^use-composed-ref$/,
          replacement: USE_COMPOSED_REF_ADAPTER,
        },
        /* === VIVENTIUM END === */
        { find: '~', replacement: path.join(__dirname, 'src/') },
        { find: '$fonts', replacement: path.resolve(__dirname, 'public/fonts') },
        {
          find: 'micromark-extension-math',
          replacement: 'micromark-extension-llm-math',
        },
      ],
    },
  };
});

interface SourcemapExclude {
  excludeNodeModules?: boolean;
}

export function sourcemapExclude(opts?: SourcemapExclude): Plugin {
  return {
    name: 'sourcemap-exclude',
    transform(code: string, id: string) {
      if (opts?.excludeNodeModules && id.includes('node_modules')) {
        return {
          code,
          // https://github.com/rollup/rollup/blob/master/docs/plugin-development/index.md#source-code-transformations
          map: { mappings: '' },
        };
      }
    },
  };
}

/* === VIVENTIUM START ===
 * Feature: Fail-closed compiled-browser dependency/license closure.
 * Purpose: Preserve a normalized package-lock inventory for every package contributing bytes to
 * emitted client chunks, outside the served frontend, before production dependency pruning removes
 * browser-only package roots.
 */
export function browserModuleClosure(): Plugin {
  function packageLockPathForModule(moduleId: string) {
    const normalizedId = moduleId.replace(/^\0+/, '').replace(/\\/g, '/').split('?')[0];
    const marker = '/node_modules/';
    const markerIndex = normalizedId.lastIndexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const packageSegments = normalizedId.slice(markerIndex + marker.length).split('/');
    const packageSegmentCount = packageSegments[0]?.startsWith('@') ? 2 : 1;
    if (packageSegments.length < packageSegmentCount) {
      throw new Error(`Unable to resolve package root for rendered module: ${moduleId}`);
    }

    const packageRoot = normalizedId
      .slice(0, markerIndex + marker.length)
      .concat(packageSegments.slice(0, packageSegmentCount).join('/'));
    const lockPath = path.relative(path.resolve(__dirname, '..'), packageRoot).replace(/\\/g, '/');
    if (
      !lockPath.split('/').includes('node_modules') ||
      path.isAbsolute(lockPath) ||
      lockPath.split('/').includes('..')
    ) {
      throw new Error('Rendered browser dependency did not map to a safe package-lock path');
    }
    return lockPath;
  }

  return {
    name: 'viventium-browser-module-closure',
    apply: 'build',
    buildStart() {
      fs.rmSync(SANDPACK_COMPLIANCE_DIRECTORY, { recursive: true, force: true });
    },
    generateBundle(_outputOptions, bundle) {
      const renderedPackageLockPaths = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const [moduleId, renderedModule] of Object.entries(output.modules)) {
            if (renderedModule.renderedLength > 0) {
              const lockPath = packageLockPathForModule(moduleId);
              if (lockPath) {
                renderedPackageLockPaths.add(lockPath);
              }
            }
          }
        }
      }

      const packageLockPaths = [...renderedPackageLockPaths].sort();
      if (!packageLockPaths.includes('node_modules/@codesandbox/sandpack-client')) {
        throw new Error('Sandpack runtime package was absent from its rendered module closure');
      }
      if (
        packageLockPaths.some(
          (lockPath) =>
            lockPath.includes('@codesandbox/nodebox') || lockPath.includes('static-browser-server'),
        )
      ) {
        throw new Error(
          'A forbidden Node/static Sandpack package entered the browser module closure',
        );
      }

      fs.mkdirSync(SANDPACK_COMPLIANCE_DIRECTORY, { recursive: true });
      fs.writeFileSync(
        path.join(SANDPACK_COMPLIANCE_DIRECTORY, 'module-closure.json'),
        `${JSON.stringify({ schemaVersion: 1, packageLockPaths }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o644 },
      );
    },
  };
}
/* === VIVENTIUM END === */
