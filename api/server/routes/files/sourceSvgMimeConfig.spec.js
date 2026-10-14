const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { mergeFileConfig, fileConfig } = require('librechat-data-provider');

describe('declared local SVG file patterns', () => {
  const source = yaml.load(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../viventium/source_of_truth/local.librechat.yaml'),
      'utf8',
    ),
  );
  const config = mergeFileConfig(source.fileConfig);
  test.each(['agents', 'default', 'openAI', 'azureOpenAI'])(
    '%s admits only the exact declared SVG MIME',
    (endpoint) => {
      const patterns = config.endpoints[endpoint].supportedMimeTypes;
      expect(fileConfig.checkType('image/svg+xml', patterns)).toBe(true);
      expect(fileConfig.checkType('image/svggxml', patterns)).toBe(false);
      expect(fileConfig.checkType('image/svg+xml/extra', patterns)).toBe(false);
    },
  );
});
