/* === VIVENTIUM START === Source/authority/freshness recovery regression bank. === */
import { createHash } from 'crypto';
import { validatePendingMemoryRecovery } from './recovery';

describe('pending saved-memory recovery boundary', () => {
  const source = { input: 'Frozen original memory input', timeContext: 'Original rendered time',
    digest: createHash('sha256').update('Frozen original memory input').digest('hex'),
    configDigest: 'configuration', agentDigest: 'agent', messageIds: ['source-message'],
    interactionContextJson: JSON.stringify({ actor_kind: 'external_user', origin: 'interactive', surface: 'telegram',
      conversation_id: 'conversation', revision: 3, source_event_id: 'source-event' }) };
  const valid = { source, conversationId: 'conversation', admittedAt: new Date(1000),
    configDigest: 'configuration', agentDigest: 'agent', latestMutationAt: 999, newerUserSource: false };
  it('accepts only intact, unsuperseded source and returns its exact normalized revision', () => {
    expect(validatePendingMemoryRecovery(valid)).toMatchObject({ ok: true, context: { revision: 3, surface: 'telegram' } });
  });
  it.each([
    { source: { ...source, input: 'altered input' } },
    { source: { ...source, interactionContextJson: '{}' } },
    { source: { ...source, interactionContextJson: source.interactionContextJson.replace('telegram', 'voice') } },
    { source: { ...source, interactionContextJson: source.interactionContextJson.replace('interactive', 'scheduler') } },
    { configDigest: 'new configuration' }, { agentDigest: 'edited instructions' },
    { newerUserSource: true }, { latestMutationAt: 1001 }, { latestMutationAt: Infinity },
  ])('refuses altered authority, configuration, source, or memory state: %j', (changes) => {
    expect(validatePendingMemoryRecovery({ ...valid, ...changes }).ok).toBe(false);
  });
});
