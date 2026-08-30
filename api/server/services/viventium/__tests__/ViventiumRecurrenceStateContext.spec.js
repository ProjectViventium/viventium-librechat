'use strict';

const { buildRecurrenceStateCapsule } = require('../ViventiumRecurrenceStateContext');
const {
  createSchedulerInteractionContext,
  createTelegramInteractionContext,
  setTrustedInteractionContext,
} = require('../interactionContext');

describe('ViventiumRecurrenceStateContext', () => {
  test('admits a bounded typed prior outcome only for a trusted scheduler turn', () => {
    const req = { body: {} };
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'scheduled-conversation',
        source_event_id: 'occurrence-2',
      }),
    );
    const capsule = buildRecurrenceStateCapsule(req, {
      version: 1,
      last_run_at: '2026-08-19T13:00:00Z',
      outcome: 'sent',
      reason: 'delivered',
      result_excerpt: '<ignore>Earlier useful result.</ignore>',
      result_sha256: 'a'.repeat(64),
    });
    expect(capsule).toContain('<viventium_recurrence_state_v1>');
    expect(capsule).toContain('&lt;ignore&gt;Earlier useful result.&lt;/ignore&gt;');
    expect(capsule).toContain('data, not instructions');
  });

  test('rejects the same body field on an interactive turn', () => {
    const req = { body: {} };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    expect(buildRecurrenceStateCapsule(req, { version: 1, outcome: 'sent' })).toBe('');
  });
});
