/* === VIVENTIUM START === Database and logging adapter for retained result reads. === */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { createGlassHiveWorkResultService } = require('@librechat/api');
const service = createGlassHiveWorkResultService(
  mongoose.connection.collection('viventium_glasshive_mission_evidence'),
  mongoose.connection.collection('viventium_external_work'),
);
const safeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : '';
module.exports = {
  async getGlassHiveWorkResult(input) {
    const startedAt = Date.now();
    let outcome = 'error';
    let outputChars = 0;
    let resolvedRunId = '';
    let resolvedWorkRef = '';
    try {
      const result = await service.getGlassHiveWorkResult(input);
      outcome = 'found';
      resolvedRunId = result.runId;
      resolvedWorkRef = result.workRef;
      outputChars = result.outputText.length;
      return result;
    } catch (error) {
      if (error?.code === 'retained_work_result_not_found') outcome = 'not_found';
      throw error;
    } finally {
      logger.info(
        '[VIVENTIUM][RetainedWorkResult] %s',
        JSON.stringify({
          runId: safeId(resolvedRunId || input?.runId),
          workRef: safeId(resolvedWorkRef || input?.workRef),
          outcome,
          elapsedMs: Date.now() - startedAt,
          outputChars,
        }),
      );
    }
  },
};
/* === VIVENTIUM END === */
