/* === VIVENTIUM START === Thin storage wiring for typed call preparation. === */
'use strict';
const { createCallPreparationRuntime, CALL_PREPARATION_LABEL } = require('@librechat/api');
const { ViventiumCallSession, Message } = require('~/db/models');
const calls = require('./CallSessionService');
module.exports = createCallPreparationRuntime({
  calls,
  tasks: require('./VoiceTaskService'),
  environment: process.env,
  getRequiredPromptText: require('./promptRegistry').getRequiredPromptText,
  begin: async (session) => {
    const binding = session.contextPreparation;
    if (!binding.deadlineAt) {
      await ViventiumCallSession.updateOne(
        {
          callSessionId: session.callSessionId,
          userId: session.userId,
          callStatus: { $ne: 'ended' },
          mode: { $ne: 'listen_only' },
          'contextPreparation.idempotencyKey': binding.idempotencyKey,
          'contextPreparation.deadlineAt': '',
        },
        {
          $set: {
            'contextPreparation.deadlineAt': new Date(
              Date.now() + binding.timeoutSeconds * 1000,
            ).toISOString(),
          },
        },
      );
    }
    const current = await calls.getCallSession(session.callSessionId);
    if (!current || current.userId !== session.userId || current.status === 'ended') {
      throw Object.assign(new Error('This call has ended.'), { code: 'call_ended', status: 410 });
    }
    if (current.mode === 'listen_only') return current;
    const tasks = require('./VoiceTaskService');
    tasks.createVoiceTask({
      callSessionId: session.callSessionId,
      userId: session.userId,
      conversationId: session.conversationId,
      turnId: binding.idempotencyKey,
      streamId: binding.streamId || binding.idempotencyKey,
      label: CALL_PREPARATION_LABEL,
      owner: { kind: 'generation_job', id: binding.streamId || binding.idempotencyKey },
    });
    await tasks.flushVoiceTaskPersistence();
    return current;
  },
  bindStream: async (session, streamId) => {
    await ViventiumCallSession.updateOne(
      {
        callSessionId: session.callSessionId,
        userId: session.userId,
        callStatus: { $ne: 'ended' },
        'contextPreparation.idempotencyKey': session.contextPreparation.idempotencyKey,
      },
      { $set: { 'contextPreparation.streamId': streamId } },
    );
  },
  recordRelease: async (session) => {
    const streamId = session.contextPreparation?.streamId;
    if (!streamId) return false;
    const result = await ViventiumCallSession.updateOne(
      {
        callSessionId: session.callSessionId,
        userId: session.userId,
        conversationId: session.conversationId,
        'contextPreparation.idempotencyKey': session.contextPreparation.idempotencyKey,
        'contextPreparation.streamId': streamId,
      },
      { $set: { 'contextPreparation.releasedStreamId': streamId } },
    );
    return result.matchedCount === 1;
  },
  readResultMessage: async (session, messageId) =>
    Message.findOne({
      user: session.userId,
      conversationId: session.conversationId,
      messageId,
      isCreatedByUser: false,
      unfinished: { $ne: true },
      error: { $ne: true },
    })
      .select('messageId')
      .lean(),
});
