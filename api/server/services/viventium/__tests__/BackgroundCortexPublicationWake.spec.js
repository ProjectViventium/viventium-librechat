jest.mock('~/server/services/viventium/VoiceTaskService', () => ({
  ...jest.requireActual('~/server/services/viventium/VoiceTaskService'),
  isVoiceTaskSuppressedDurably: jest.fn(async () => false),
}));
const db = require('~/models');
const taskService = require('~/server/services/viventium/VoiceTaskService');
const {
  persistPreparedCortexFollowUpMessage,
} = require('~/server/services/viventium/BackgroundCortexFollowUpService');
beforeEach(() => taskService.resetVoiceTasksForTests());
test.each([
  'saved',
  'save_failed',
  'foreign_call',
  'foreign_owner',
  'foreign_conversation',
  'durable_worker',
  'suppressed',
  'empty',
])('persisted child publication boundary: %s', async (mode) => {
  const task = taskService.createVoiceTask({
    callSessionId: 'call-wake',
    userId: mode === 'foreign_owner' ? 'foreign-owner' : 'user-wake',
    conversationId: mode === 'foreign_conversation' ? 'foreign-conversation' : 'conversation-wake',
    streamId: 'stream-wake',
    owner: { kind: 'generation_job', id: 'stream-wake' },
  });
  taskService.completeVoiceTask(task.taskId, { resultMessageId: 'parent-wake' });
  const events = [];
  taskService.subscribeVoiceTasksForCall('call-wake', (e) => events.push(e));
  const saved = [];
  const save = jest.spyOn(db, 'saveMessage').mockImplementation(async (_req, message) => {
    if (mode === 'save_failed')
      throw Object.assign(new Error('Synthetic storage failure'), {
        code: 'synthetic_storage_failure',
      });
    saved.push(message);
    return message;
  });
  const hydrate = jest
    .spyOn(taskService, 'hydrateVoiceTask')
    .mockImplementation(async (id, scope) => {
      expect(saved).toHaveLength(1);
      expect(scope).toEqual({
        callSessionId: 'call-wake',
        userId: 'user-wake',
        requireDurable: true,
      });
      return mode === 'foreign_call' ? null : taskService.getVoiceTask(id);
    });
  const suppression = jest
    .spyOn(taskService, 'isVoiceTaskSuppressedDurably')
    .mockResolvedValue(false);
  const req = {
    user: { id: 'user-wake' },
    body: {
      viventiumCallSessionId: 'call-wake',
      viventiumVoiceTaskId: task.taskId,
      streamId: 'stream-wake',
    },
  };
  const input = {
    req,
    conversationId: 'conversation-wake',
    parentMessageId: 'parent-wake',
    agent: { id: 'main-wake' },
    insightsData: { cortexCount: 1 },
  };
  const prepared = {
    voiceTaskId: task.taskId,
    text: mode === 'empty' ? '' : 'Main authored synthetic result.',
    shouldForceVisibleFollowUp: false,
    finalContinuationContext: { hasMovedOn: false },
    conversationMessages: [],
    durableMissionEvidence: mode === 'durable_worker',
    suppressed: mode === 'suppressed',
  };
  try {
    if (mode === 'save_failed')
      await expect(persistPreparedCortexFollowUpMessage(input, prepared)).rejects.toMatchObject({
        code: 'synthetic_storage_failure',
      });
    else await persistPreparedCortexFollowUpMessage(input, prepared);
    if (mode === 'saved') {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        phase: 'follow_up',
        source: { id: saved[0].messageId },
        resultMessageId: 'parent-wake',
      });
      expect(JSON.stringify(events[0])).not.toContain('Main authored synthetic result');
      expect(hydrate).toHaveBeenCalledTimes(1);
    } else expect(events).toHaveLength(0);
  } finally {
    save.mockRestore();
    hydrate.mockRestore();
    suppression.mockRestore();
  }
});
