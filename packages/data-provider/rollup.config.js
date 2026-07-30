/* VIVENTIUM START: Keep package compilation on the maintained Rollup TypeScript plugin. */
import typescript from '@rollup/plugin-typescript';
/* VIVENTIUM END */
import resolve from '@rollup/plugin-node-resolve';
import pkg from './package.json';
import peerDepsExternal from 'rollup-plugin-peer-deps-external';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';

/* VIVENTIUM START: Use explicit TypeScript resolution for the current Rollup build graph,
 * including modules that have both `name.ts` and a `name/` directory. Keep per-output plugin
 * instances so declaration paths remain inside each Rollup output directory. */
const plugins = ({ declarations, outDir }) => [
  peerDepsExternal(),
  resolve({ extensions: ['.mjs', '.js', '.json', '.node', '.ts', '.tsx'] }),
  replace({
    __IS_DEV__: process.env.NODE_ENV === 'development',
    preventAssignment: true,
  }),
  commonjs(),
  typescript({
    tsconfig: './tsconfig.json',
    declaration: declarations,
    declarationDir: declarations ? 'dist/types' : undefined,
    rootDir: 'src',
    outDir,
    noEmit: false,
  }),
  terser(),
];
/* VIVENTIUM END */

export default [
  {
    input: 'src/index.ts',
    output: [
      {
        file: pkg.main,
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: pkg.module,
        format: 'esm',
        sourcemap: true,
        exports: 'named',
      },
    ],
    ...{
      external: [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        'react',
        'react-dom',
      ],
      preserveSymlinks: true,
      plugins: plugins({ declarations: true, outDir: 'dist' }),
    },
  },
  // Separate bundle for react-query related part
  {
    input: 'src/react-query/index.ts',
    output: [
      {
        file: 'dist/react-query/index.es.js',
        format: 'esm',
        exports: 'named',
        sourcemap: true,
      },
    ],
    external: [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      'react',
      'react-dom',
      // 'librechat-data-provider', // Marking main part as external
    ],
    preserveSymlinks: true,
    plugins: plugins({ declarations: false, outDir: 'dist/react-query' }),
  },
];
