const { spawnSync } = require('node:child_process');

describe('determineFileType', () => {
  // VIVENTIUM START: regression for GHSA-5v7r-6r5c-r473.
  it('safely identifies a truncated ASF header without looping', async () => {
    const malformedAsfHeader =
      '3026b2758e66cf11a6d9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `(async () => {
          const { determineFileType } = require(process.argv[1]);
          const result = await determineFileType(Buffer.from(process.argv[2], 'hex'), true);
          process.stdout.write(JSON.stringify(result ?? null));
        })().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });`,
        require.resolve('./files'),
        malformedAsfHeader,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });
  // VIVENTIUM END
});
