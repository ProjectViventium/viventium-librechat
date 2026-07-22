const fs = require('fs');
const path = require('path');

/* === VIVENTIUM START ===
 * Purpose: Keep every resumable SSE route wired to close-during-readiness
 * cancellation; scheduler route and manager tests own the timing/AbortSignal
 * behavioral proof.
 */
describe('resumable SSE request cancellation wiring', () => {
  const routeCases = [
    ['../../agents/index.js', 1],
    ['../voice.js', 1],
    ['../scheduler.js', 2],
    ['../gateway.js', 1],
    ['../telegram.js', 1],
  ];

  test.each(routeCases)(
    '%s arms response close before every asynchronous stream lookup',
    (file, expected) => {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      const cancellationWiring = source.match(
        /res\.once\('close', onRequestClose\);[\s\S]*?GenerationJobManager\.getJob\(streamId\)[\s\S]*?GenerationJobManager\.subscribe\([\s\S]*?requestAbort\.signal,/g,
      );

      expect(cancellationWiring).toHaveLength(expected);
    },
  );
});
/* === VIVENTIUM END === */
