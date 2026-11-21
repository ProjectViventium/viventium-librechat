const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { mergeFileConfig, fileConfig } = require('librechat-data-provider');

describe('declared local file admission patterns', () => {
  const source = yaml.load(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../viventium/source_of_truth/local.librechat.yaml'),
      'utf8',
    ),
  );
  const config = mergeFileConfig(source.fileConfig);
  test.each(['default', 'openAI', 'azureOpenAI'])(
    '%s admits only the exact declared SVG MIME',
    (endpoint) => {
      const patterns = config.endpoints[endpoint].supportedMimeTypes;
      expect(fileConfig.checkType('image/svg+xml', patterns)).toBe(true);
      expect(fileConfig.checkType('image/svggxml', patterns)).toBe(false);
      expect(fileConfig.checkType('image/svg+xml/extra', patterns)).toBe(false);
    },
  );

  test.each(['image/svg+xml', 'application/x-synthetic-binary', 'model/gltf-binary'])(
    'agents admits selected %s for its declared file carrier',
    (mime) => {
      expect(fileConfig.checkType(mime, config.endpoints.agents.supportedMimeTypes)).toBe(true);
    },
  );

  test('agents retains upload count and byte limits with arbitrary format admission', () => {
    expect(config.endpoints.agents).toMatchObject({
      disabled: false,
      fileLimit: 100,
      fileSizeLimit: 50 * 1024 ** 2,
      totalSizeLimit: 100 * 1024 ** 2,
    });
  });
});
