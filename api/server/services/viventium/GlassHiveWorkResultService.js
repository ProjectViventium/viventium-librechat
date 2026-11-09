/* === VIVENTIUM START === Database and logging adapter for retained result reads. === */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  createGlassHiveWorkResultService,
  readNativeCoordinatorGoalResult,
} = require('@librechat/api');
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
      const target =
        await require('./NativeCoordinatorWorkService').resolveNativeCoordinatorWorkIdentity(input);
      const selected = target?.nativeWorkRef ? { ...input, workRef: target.nativeWorkRef } : input;
      let result;
      if (target && !target.nativeWorkRef) {
        if (target.kind !== 'goal')
          throw Object.assign(new Error('retained_work_result_not_found'), {
            code: 'retained_work_result_not_found',
          });
        const retained = await readNativeCoordinatorGoalResult(
          {
            ownerId: input.ownerId,
            conversationId: target.nativeConversationId,
            goalId: target.nativeGoalId,
            ...(input.runId ? { runId: input.runId } : {}),
          },
          (ownerId, path) =>
            require('./GlassHiveAccountService').requestAccountApi({ ownerId, path }),
        );
        result = {
          ...retained,
          workRef: input.workRef,
          resultWorkState: retained.state,
          selection: input.runId ? 'exact_run' : 'latest_retained_terminal_result',
          currentRunMatch: retained.runId === target.runId ? 'current' : 'historical',
        };
      } else {
        result = await service.getGlassHiveWorkResult(selected);
      }
      outcome = 'found';
      resolvedRunId = result.runId;
      resolvedWorkRef = result.workRef;
      outputChars = result.outputText.length;
      return target
        ? { ...result, workRef: input.workRef, nativeWorkRef: target.nativeWorkRef }
        : result;
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
