/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_LOGGER: string;
  readonly VITE_LOGGER_FILTER: string;
  // Add other env variables here
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/* VIVENTIUM START
 * The published Sandpack package exposes runtime declarations through an exports subpath, but this
 * client's legacy `moduleResolution: node` cannot resolve that conditional `types` entry.
 */
declare module '@codesandbox/sandpack-client/clients/runtime' {
  export const SandpackRuntime: unknown;
}
/* VIVENTIUM END */
