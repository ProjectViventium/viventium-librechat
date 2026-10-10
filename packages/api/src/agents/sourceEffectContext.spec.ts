import { buildTrustedSourceSelectionCapsule } from './sourceSelectionContext';
import {
  bindLogicalTurnContext,
  getTrustedInteractionContext,
  setTrustedInteractionContext,
  interactionContextMetadata,
  normalizeInteractionContext,
} from './interactionContext';

/* === VIVENTIUM START === Outcome facts enter Main through the exact server-owned source claim. === */
const context = {
  actor_kind: 'external_user',
  origin: 'interactive',
  surface: 'voice',
  conversation_id: 'chat',
  source_event_id: 'S2',
  revision: 2,
  logical_turn_id: 'turn',
  source_segments: [
    {
      ordinal: 0,
      source_index: 0,
      source_event_id: 'S1',
      authoring_revision: 2,
      text: 'Create a CSV.',
    },
    {
      ordinal: 1,
      source_index: 0,
      source_event_id: 'S2',
      authoring_revision: 2,
      text: "Actually, don't.",
    },
  ],
} as const;
const facts = {
  effects: [],
  work: [
    { sourceEventId: 'S1', originRef: 'origin', workRef: 'existing', launchState: 'accepted' },
  ],
};
test('the exact server claim keeps facts, ordered corrections, and omits them from public message metadata', () => {
  const req = {};
  setTrustedInteractionContext(req, context);
  bindLogicalTurnContext(req, { ...context, source_recovery_facts: facts });
  expect(getTrustedInteractionContext(req)?.source_recovery_facts).toEqual(facts);
  expect(interactionContextMetadata(req)).not.toHaveProperty('source_recovery_facts');
  const capsule = buildTrustedSourceSelectionCapsule(getTrustedInteractionContext(req), {
    supersede_scope: 'response_only',
  });
  const encoded = capsule
    .split('<viventium_source_outcomes encoding="base64url-json-v1">')[1]
    .split('\n')
    .find((line) => /^[A-Za-z0-9_-]+$/.test(line))!;
  expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
    version: 1,
    effects: [],
    work: [{ sourceOrdinal: 1, originRef: 'origin', workRef: 'existing', launchState: 'accepted' }],
  });
  expect(capsule).toContain('including corrections');
  expect(capsule).toContain('unknown outcome is not proof that nothing happened');
});
test('raw input normalization cannot inject effect facts', () => {
  expect(
    normalizeInteractionContext({ ...context, source_recovery_facts: facts } as typeof context),
  ).not.toHaveProperty('source_recovery_facts');
});
test('an outcome for an unowned source cannot enter the capsule', () => {
  expect(() =>
    buildTrustedSourceSelectionCapsule(
      {
        ...context,
        source_recovery_facts: {
          effects: [],
          work: [{ ...facts.work[0], sourceEventId: 'foreign' }],
        },
      },
      { supersede_scope: 'response_only' },
    ),
  ).toThrow('source_recovery_fact_source_unavailable');
});
/* === VIVENTIUM END === */
