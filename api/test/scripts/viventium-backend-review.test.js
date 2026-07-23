const fs = require('fs');
const path = require('path');

/* === VIVENTIUM START ===
 * Purpose: Keep the data-schema CI lane deterministic when multiple suites
 * create mongodb-memory-server instances against one binary cache.
 */
describe('Viventium backend review workflow', () => {
  test('runs data-schema tests serially to avoid shared Mongo binary lock races', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../../.github/workflows/backend-review.yml'),
      'utf8',
    );
    const dataSchemaJob = workflow.match(
      /test-data-schemas:[\s\S]*?(?=\n {2}test-packages-api:)/,
    )?.[0];

    expect(dataSchemaJob).toContain(
      'run: cd packages/data-schemas && npm run test:ci -- --runInBand',
    );
  });

  test('fetches complete history for the managed-agent predecessor audit', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../../.github/workflows/backend-review.yml'),
      'utf8',
    );
    const apiJob = workflow.match(/test-api:[\s\S]*?(?=\n {2}test-data-provider:)/)?.[0];

    expect(apiJob).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
  });
});
/* === VIVENTIUM END === */
