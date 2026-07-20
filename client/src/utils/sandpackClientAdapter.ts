/*
 * VIVENTIUM START
 * Browser-only adapter for @codesandbox/sandpack-client.
 *
 * The utility functions below are adapted from CodeSandbox BV's Sandpack Client 2.19.8,
 * Copyright 2022 CodeSandbox BV, licensed under Apache-2.0. Viventium changed the module
 * boundary and client routing so browser artifacts cannot load the Nodebox or unshippable static
 * client implementations.
 * See sandpackClientAdapter.NOTICE.md for attribution and license terms.
 */

type Dependencies = Record<string, string>;

interface SandpackBundlerFile {
  code: string;
  hidden?: boolean;
  active?: boolean;
  readOnly?: boolean;
}

type SandpackBundlerFiles = Record<string, SandpackBundlerFile>;

interface ClientOptions {
  externalResources?: string[];
  bundlerURL?: string;
  startRoute?: string;
  width?: string;
  height?: string;
  [key: string]: object | string | boolean | number | string[] | undefined;
}

interface SandboxSetup {
  files: SandpackBundlerFiles;
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
  entry?: string;
  template?: string;
  disableDependencyPreprocessing?: boolean;
}

interface ErrorScriptLine {
  lineNumber: number;
  content: string;
  highlight: boolean;
}

interface ErrorStackFrame {
  _originalColumnNumber: number;
  _originalFileName: string;
  _originalLineNumber: number;
  _originalScriptCode: ErrorScriptLine[];
}

interface SandpackErrorMessage {
  title: string;
  path: string;
  message: string;
  line: number;
  column: number;
  payload?: { frames?: ErrorStackFrame[] };
}

interface SandpackError {
  message: string;
  line?: number;
  column?: number;
  path?: string;
  title?: string;
}

interface SandpackClientConstructor {
  new (
    selector: string | HTMLIFrameElement,
    sandboxSetup: SandboxSetup,
    options?: ClientOptions,
  ): object;
}

const DEFAULT_SANDBOX_PERMISSIONS = [
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-pointer-lock',
  'allow-popups',
  'allow-presentation',
  'allow-same-origin',
  'allow-scripts',
];

const DEPENDENCY_ERROR_MESSAGE =
  '"dependencies" was not specified - provide either a package.json or a "dependencies" value';
const ENTRY_ERROR_MESSAGE =
  '"entry" was not specified - provide either a package.json with the "main" field or an "entry" value';

function createError(message: string) {
  return `[sandpack-client]: ${message}`;
}

function nullthrows<T>(value?: T | null, message = 'Value is nullish'): T {
  if (value == null) {
    throw new Error(createError(message));
  }
  return value;
}

function createPackageJSON(
  dependencies: Dependencies = {},
  devDependencies: Dependencies = {},
  entry = '/index.js',
) {
  return JSON.stringify(
    {
      name: 'sandpack-project',
      main: entry,
      dependencies,
      devDependencies,
    },
    null,
    2,
  );
}

export function normalizePath<R>(path: R): R {
  if (typeof path === 'string') {
    return (path.startsWith('/') ? path : `/${path}`) as R;
  }
  if (Array.isArray(path)) {
    return path.map((item: string) => (item.startsWith('/') ? item : `/${item}`)) as R;
  }
  if (typeof path === 'object' && path !== null) {
    return Object.entries(path).reduce<Record<string, object | string>>((result, [key, value]) => {
      result[key.startsWith('/') ? key : `/${key}`] = value as object | string;
      return result;
    }, {}) as R;
  }
  return null as R;
}

export function addPackageJSONIfNeeded(
  files: SandpackBundlerFiles,
  dependencies?: Dependencies,
  devDependencies?: Dependencies,
  entry?: string,
) {
  const normalizedFilesPath = normalizePath(files);
  const packageJsonFile = normalizedFilesPath['/package.json'];

  if (!packageJsonFile) {
    nullthrows(dependencies, DEPENDENCY_ERROR_MESSAGE);
    nullthrows(entry, ENTRY_ERROR_MESSAGE);
    normalizedFilesPath['/package.json'] = {
      code: createPackageJSON(dependencies, devDependencies, entry),
    };
    return normalizedFilesPath;
  }

  const packageJsonContent = JSON.parse(packageJsonFile.code) as {
    dependencies?: Dependencies;
    devDependencies?: Dependencies;
    main?: string;
  };
  nullthrows(!(!dependencies && !packageJsonContent.dependencies), ENTRY_ERROR_MESSAGE);
  if (dependencies) {
    packageJsonContent.dependencies = { ...packageJsonContent.dependencies, ...dependencies };
  }
  if (devDependencies) {
    packageJsonContent.devDependencies = {
      ...packageJsonContent.devDependencies,
      ...devDependencies,
    };
  }
  if (entry) {
    packageJsonContent.main = entry;
  }
  normalizedFilesPath['/package.json'] = {
    code: JSON.stringify(packageJsonContent, null, 2),
  };
  return normalizedFilesPath;
}

function getRelevantStackFrame(frames?: ErrorStackFrame[]) {
  return frames?.find((frame) => Boolean(frame._originalFileName));
}

function getErrorInOriginalCode(errorFrame: ErrorStackFrame) {
  const lastScriptLine = errorFrame._originalScriptCode.at(-1);
  if (!lastScriptLine) {
    return '';
  }
  const numberOfLineNumberCharacters = lastScriptLine.lineNumber.toString().length;
  const extraLineLeadingSpaces =
    5 + numberOfLineNumberCharacters + errorFrame._originalColumnNumber;

  return errorFrame._originalScriptCode.reduce((result, scriptLine) => {
    const leadingChar = scriptLine.highlight ? '>' : ' ';
    const lineNumber = scriptLine.lineNumber.toString().padStart(numberOfLineNumberCharacters, ' ');
    const extraLine = scriptLine.highlight ? `\n${' '.repeat(extraLineLeadingSpaces)}^` : '';
    return `${result}\n${leadingChar} ${lineNumber} | ${scriptLine.content}${extraLine}`;
  }, '');
}

export function extractErrorDetails(message: SandpackErrorMessage): SandpackError {
  if (message.title === 'SyntaxError') {
    const { title, path, line, column } = message;
    return { title, path, message: message.message, line, column };
  }

  const relevantStackFrame = getRelevantStackFrame(message.payload?.frames);
  if (!relevantStackFrame) {
    return { message: message.message };
  }
  const location = ` (${relevantStackFrame._originalLineNumber}:${relevantStackFrame._originalColumnNumber})`;
  return {
    message: `${relevantStackFrame._originalFileName}: ${message.message}${location}\n${getErrorInOriginalCode(relevantStackFrame)}`,
    title: message.title,
    path: relevantStackFrame._originalFileName,
    line: relevantStackFrame._originalLineNumber,
    column: relevantStackFrame._originalColumnNumber,
  };
}

export async function loadSandpackClient(
  iframeSelector: string | HTMLIFrameElement,
  sandboxSetup: SandboxSetup,
  options: ClientOptions = {},
) {
  if (sandboxSetup.template === 'node') {
    throw new Error('Viventium artifacts do not support the Sandpack node template.');
  }

  if (!options.bundlerURL) {
    throw new Error(
      'Viventium requires an isolated Sandpack bundler URL. Run Viventium Doctor or configure the custom bundler origin.',
    );
  }
  const bundlerURL = new URL(options.bundlerURL, window.location.href);
  if (!['http:', 'https:'].includes(bundlerURL.protocol)) {
    throw new Error('The Sandpack bundler URL must use HTTP or HTTPS.');
  }
  if (
    bundlerURL.pathname !== '/' ||
    bundlerURL.search.length > 0 ||
    bundlerURL.hash.length > 0 ||
    bundlerURL.username.length > 0 ||
    bundlerURL.password.length > 0
  ) {
    throw new Error(
      'The Sandpack bundler URL must use its origin root with a trailing slash and no credentials, query, or fragment.',
    );
  }
  if (bundlerURL.origin === window.location.origin) {
    throw new Error(
      'The Sandpack bundler must use a different origin from LibreChat so browser workers remain isolated.',
    );
  }

  const Client = (await import('@codesandbox/sandpack-client/clients/runtime'))
    .SandpackRuntime as SandpackClientConstructor;
  const runtimeSetup =
    sandboxSetup.template === 'static'
      ? {
          ...sandboxSetup,
          dependencies: sandboxSetup.dependencies ?? {},
          entry: sandboxSetup.entry ?? '/index.html',
        }
      : sandboxSetup;
  let clientTarget = iframeSelector;
  if (typeof iframeSelector === 'string') {
    const element = document.querySelector(iframeSelector);
    nullthrows(element, `The element '${iframeSelector}' was not found`);
    if (element instanceof HTMLIFrameElement) {
      clientTarget = element;
    } else {
      const iframe = document.createElement('iframe');
      iframe.style.border = '0';
      iframe.style.width = options.width ?? '100%';
      iframe.style.height = options.height ?? '100%';
      iframe.style.overflow = 'hidden';
      nullthrows(element.parentNode, 'The given iframe placeholder does not have a parent.');
      element.parentNode.replaceChild(iframe, element);
      clientTarget = iframe;
    }
  }
  if (clientTarget instanceof HTMLIFrameElement) {
    const existingPermissions = clientTarget.getAttribute('sandbox')?.split(/\s+/).filter(Boolean);
    const safePermissions = (
      existingPermissions
        ? existingPermissions.filter((permission) =>
            DEFAULT_SANDBOX_PERMISSIONS.includes(permission),
          )
        : [...DEFAULT_SANDBOX_PERMISSIONS]
    ).sort();
    clientTarget.setAttribute('sandbox', [...new Set(safePermissions)].join(' '));
  }
  return new Client(clientTarget, runtimeSetup, { ...options, bundlerURL: bundlerURL.toString() });
}

/* VIVENTIUM END */
