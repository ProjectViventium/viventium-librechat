const owner = '~/server/services/viventium/VoiceTaskService';
const {
  createVoiceTask,
  completeVoiceTask,
  observeGenerationEvent,
  snapshotEvent,
  resetVoiceTasksForTests,
  cancelVoiceTask,
  subscribeVoiceTasksForCall,
} = require(owner);
function parent(overrides = {}) {
  const task = createVoiceTask({
    callSessionId: 'synthetic-call',
    userId: 'synthetic-user',
    conversationId: 'synthetic-conversation',
    streamId: 'synthetic-stream',
    owner: { kind: 'generation_job', id: 'synthetic-stream' },
    ...overrides,
  });
  completeVoiceTask(task.taskId, { resultMessageId: 'synthetic-parent' });
  return task;
}
function child(changes = {}) {
  return {
    event: 'on_cortex_followup',
    data: {
      messageId: 'synthetic-child',
      parentMessageId: 'synthetic-parent',
      conversationId: 'synthetic-conversation',
      text: 'PRIVATE INTERNAL TEXT MUST NOT BE IN TASK EVENT',
      ...changes,
    },
  };
}
beforeEach(() => resetVoiceTasksForTests());
test('persisted child wakes a completed exact Main parent without replacing its result or exposing text', () => {
  const p = parent();
  const events = [];
  subscribeVoiceTasksForCall('synthetic-call', (e) => events.push(e));
  const event = observeGenerationEvent(p.taskId, child());
  expect(event).toMatchObject({
    state: 'completed',
    phase: 'follow_up',
    source: { id: 'synthetic-child' },
    resultMessageId: 'synthetic-parent',
    owner: { kind: 'generation_job', id: 'synthetic-stream' },
  });
  expect(events).toHaveLength(1);
  expect(JSON.stringify(event)).not.toContain('PRIVATE INTERNAL');
  expect(snapshotEvent(p.taskId)).toMatchObject({
    phase: 'follow_up',
    source: { id: 'synthetic-child' },
    resultMessageId: 'synthetic-parent',
  });
});
test('stable child ID deduplicates producer retry and distinct child IDs stay distinct', () => {
  const p = parent();
  expect(observeGenerationEvent(p.taskId, child())).not.toBeNull();
  expect(observeGenerationEvent(p.taskId, child())).toBeNull();
  expect(observeGenerationEvent(p.taskId, child({ messageId: 'synthetic-second' }))).toMatchObject({
    source: { id: 'synthetic-second' },
  });
  expect(snapshotEvent(p.taskId)).toMatchObject({
    source: { id: 'synthetic-second' },
    sources: [{ id: 'synthetic-child' }, { id: 'synthetic-second' }],
  });
});
test.each([
  { messageId: '' },
  { messageId: 'synthetic-parent' },
  { parentMessageId: 'foreign' },
  { conversationId: 'foreign' },
])('rejects incomplete or foreign publication %p', (change) => {
  const p = parent();
  expect(observeGenerationEvent(p.taskId, child(change))).toBeNull();
});
test.each([
  { kind: 'glasshive_run', id: 'synthetic-stream' },
  { kind: 'generation_job', id: 'foreign' },
])('rejects nonparent owner %p', (owner) => {
  const p = parent({ owner });
  expect(observeGenerationEvent(p.taskId, child())).toBeNull();
});
test('explicit cancellation remains silent and regular late progress stays terminal', () => {
  const p = createVoiceTask({
    callSessionId: 'synthetic-call',
    userId: 'synthetic-user',
    conversationId: 'synthetic-conversation',
    streamId: 'cancel-stream',
  });
  cancelVoiceTask(p.taskId, { userId: 'synthetic-user' });
  expect(observeGenerationEvent(p.taskId, child())).toBeNull();
  const p2 = parent({
    streamId: 'second-stream',
    owner: { kind: 'generation_job', id: 'second-stream' },
  });
  expect(
    observeGenerationEvent(p2.taskId, { event: 'on_cortex_update', data: { id: 'late' } }),
  ).toBeNull();
});

test('published event and replay retain the immutable original task creation stamp', () => {
  const p = parent();
  const event = observeGenerationEvent(p.taskId, child({ createdAt: 'invalid' }));
  expect(event.createdAt).toBe(p.createdAt);
  expect(snapshotEvent(p.taskId).createdAt).toBe(p.createdAt);
});
