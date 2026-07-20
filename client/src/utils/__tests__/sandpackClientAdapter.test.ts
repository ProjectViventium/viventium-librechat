import fs from 'fs';
import path from 'path';
import {
  addPackageJSONIfNeeded,
  extractErrorDetails,
  loadSandpackClient,
  normalizePath,
} from '../sandpackClientAdapter';

const mockRuntimeClient = jest.fn();

jest.mock(
  '@codesandbox/sandpack-client/clients/runtime',
  () => ({ SandpackRuntime: mockRuntimeClient }),
  { virtual: true },
);

describe('sandpackClientAdapter', () => {
  const files = { '/index.tsx': { code: 'export default null;' } };
  const isolatedBundlerURL = 'https://bundler.example.invalid/';
  let iframe: HTMLIFrameElement;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    mockRuntimeClient.mockReset();
  });

  it('routes static artifacts to the browser runtime without static-browser-server', async () => {
    await loadSandpackClient(
      iframe,
      { files, template: 'static' },
      { width: '100%', bundlerURL: isolatedBundlerURL },
    );

    expect(mockRuntimeClient).toHaveBeenCalledWith(
      iframe,
      { files, template: 'static', dependencies: {}, entry: '/index.html' },
      { width: '100%', bundlerURL: isolatedBundlerURL },
    );
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-presentation allow-same-origin allow-scripts',
    );
  });

  it('preserves explicit static runtime dependencies and entry', async () => {
    await loadSandpackClient(
      iframe,
      {
        files,
        template: 'static',
        dependencies: { preact: '10.27.2' },
        entry: '/site.html',
      },
      { bundlerURL: isolatedBundlerURL },
    );

    expect(mockRuntimeClient).toHaveBeenCalledWith(
      iframe,
      {
        files,
        template: 'static',
        dependencies: { preact: '10.27.2' },
        entry: '/site.html',
      },
      { bundlerURL: isolatedBundlerURL },
    );
  });

  it.each(['react-ts', 'create-react-app-typescript', 'parcel', undefined])(
    'routes the %s artifact template to the browser runtime client',
    async (template) => {
      await loadSandpackClient(iframe, { files, template }, { bundlerURL: isolatedBundlerURL });

      expect(mockRuntimeClient).toHaveBeenCalledWith(
        iframe,
        { files, template },
        { bundlerURL: isolatedBundlerURL },
      );
    },
  );

  it('retains worker authority only when an explicit custom bundler has an isolated origin', async () => {
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-top-navigation allow-popups-to-escape-sandbox',
    );

    await loadSandpackClient(
      iframe,
      { files, template: 'react-ts' },
      { bundlerURL: 'https://bundler.example.invalid/' },
    );

    expect(mockRuntimeClient).toHaveBeenCalledWith(
      iframe,
      { files, template: 'react-ts' },
      { bundlerURL: 'https://bundler.example.invalid/' },
    );
    expect(iframe.getAttribute('sandbox')).toBe('allow-forms allow-same-origin allow-scripts');
  });

  it('fails closed when the local isolated bundler URL is missing or same-origin', async () => {
    await expect(loadSandpackClient(iframe, { files, template: 'static' }, {})).rejects.toThrow(
      'isolated Sandpack bundler URL',
    );
    await expect(
      loadSandpackClient(
        iframe,
        { files, template: 'static' },
        { bundlerURL: window.location.href },
      ),
    ).rejects.toThrow('must use a different origin');
    await expect(
      loadSandpackClient(
        iframe,
        { files, template: 'static' },
        { bundlerURL: 'https://bundler.example.invalid/nested?unsafe=true' },
      ),
    ).rejects.toThrow('origin root with a trailing slash');
    expect(mockRuntimeClient).not.toHaveBeenCalled();
  });

  it('replaces a string-selected placeholder with a hardened iframe before client startup', async () => {
    const placeholder = document.createElement('div');
    placeholder.id = 'sandpack-placeholder';
    document.body.appendChild(placeholder);

    try {
      await loadSandpackClient(
        '#sandpack-placeholder',
        { files, template: 'static' },
        { bundlerURL: isolatedBundlerURL },
      );

      const clientTarget = mockRuntimeClient.mock.calls[0][0];
      expect(clientTarget).toBeInstanceOf(HTMLIFrameElement);
      expect(clientTarget.parentNode).toBe(document.body);
      expect(clientTarget.getAttribute('sandbox')).toContain('allow-same-origin');
    } finally {
      document.body.replaceChildren();
    }
  });

  it('rejects node artifacts before loading a client', async () => {
    await expect(
      loadSandpackClient(iframe, { files, template: 'node' }, { bundlerURL: isolatedBundlerURL }),
    ).rejects.toThrow('Viventium artifacts do not support the Sandpack node template');

    expect(mockRuntimeClient).not.toHaveBeenCalled();
  });

  it('preserves Sandpack path and package helpers used by sandpack-react', () => {
    expect(normalizePath('index.ts')).toBe('/index.ts');
    expect(normalizePath(['index.ts', '/styles.css'])).toEqual(['/index.ts', '/styles.css']);
    expect(
      addPackageJSONIfNeeded(files, { react: '18.3.1' }, {}, '/index.tsx')['/package.json'],
    ).toEqual({
      code: JSON.stringify(
        {
          name: 'sandpack-project',
          main: '/index.tsx',
          dependencies: { react: '18.3.1' },
          devDependencies: {},
        },
        null,
        2,
      ),
    });
  });

  it('preserves Sandpack syntax-error extraction', () => {
    expect(
      extractErrorDetails({
        title: 'SyntaxError',
        path: '/index.tsx',
        message: 'Unexpected token',
        line: 2,
        column: 4,
        payload: {},
      }),
    ).toEqual({
      title: 'SyntaxError',
      path: '/index.tsx',
      message: 'Unexpected token',
      line: 2,
      column: 4,
    });
  });

  it('ships the complete attributed Apache-2.0 license beside the adapter provenance', () => {
    const clientRoot = path.resolve(__dirname, '../../..');
    const notice = fs.readFileSync(
      path.join(clientRoot, 'src/utils/sandpackClientAdapter.NOTICE.md'),
      'utf8',
    );
    const license = fs.readFileSync(
      path.join(clientRoot, 'third_party/sandpack-client/LICENSE.txt'),
      'utf8',
    );

    expect(notice).toContain('client/third_party/sandpack-client/LICENSE.txt');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('Copyright 2022 CodeSandbox BV');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
  });
});
