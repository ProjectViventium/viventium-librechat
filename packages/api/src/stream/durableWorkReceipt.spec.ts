import { publicDurableWorkReceipt, resolveCurrentDurableWorkReceipt } from './durableWorkReceipt';

function fixture() {
  return {
    status: 'error',
    metadata: {
      responseMessageId: 'answer',
      interactionContext: { source_event_id: 'source' },
      adapterCapabilities: { supersede_scope: 'response_only' },
      deliveryPolicy: { commit_authority: 'external_adapter' },
      durableEffectReceipt: {
        effect_kind: 'durable_work_accepted',
        effect_ref: 'work',
        committed_at: 1,
        response_message_id: 'answer',
        source_event_id: 'source',
      },
    },
  };
}

test('a current failed reply retains a receipt without claiming that the reply was superseded', () => {
  const job = fixture();
  const result = resolveCurrentDurableWorkReceipt({
    job,
    responseMessageId: 'answer',
    sourceEventId: 'source',
    requireSuperseded: false,
  });
  expect(result.receipt).toEqual(job.metadata.durableEffectReceipt);
  expect(publicDurableWorkReceipt(result.receipt!)).toEqual({
    effect_ref: 'work',
    effect_kind: 'durable_work_accepted',
  });
  expect(
    resolveCurrentDurableWorkReceipt({
      job,
      responseMessageId: 'answer',
      sourceEventId: 'source',
    }).receipt,
  ).toBeNull();
});

test.each([
  'source',
  'response',
  'job-source',
  'job-response',
  'mode',
  'policy',
  'kind',
  'ref',
  'time',
  'missing-source',
])('rejects changed %s proof', (change) => {
  const job = fixture();
  const receipt = job.metadata.durableEffectReceipt;
  if (change === 'source') receipt.source_event_id = 'foreign';
  if (change === 'response') receipt.response_message_id = 'foreign';
  if (change === 'job-source') job.metadata.interactionContext.source_event_id = 'foreign';
  if (change === 'job-response') job.metadata.responseMessageId = 'foreign';
  if (change === 'mode') job.metadata.adapterCapabilities.supersede_scope = 'all';
  if (change === 'policy') job.metadata.deliveryPolicy.commit_authority = 'server';
  if (change === 'kind') receipt.effect_kind = 'unverified';
  if (change === 'ref') receipt.effect_ref = '';
  if (change === 'time') receipt.committed_at = 0;
  const result = resolveCurrentDurableWorkReceipt({
    job,
    responseMessageId: 'answer',
    sourceEventId: change === 'missing-source' ? undefined : 'source',
    requireSuperseded: false,
  });
  expect(result.receipt).toBeNull();
});

test('public projection keeps uncertainty and drops private source identity', () => {
  const receipt = {
    ...fixture().metadata.durableEffectReceipt,
    effect_kind: 'durable_work_accepted' as const,
    confirmation_pending: true,
  };
  expect(publicDurableWorkReceipt(receipt)).toEqual({
    effect_ref: 'work',
    effect_kind: 'durable_work_accepted',
    confirmation_pending: true,
  });
});

test('rejects an invalid uncertainty flag instead of asserting a malformed receipt type', () => {
  const job = fixture();
  const malformed = {
    ...job,
    metadata: {
      ...job.metadata,
      durableEffectReceipt: {
        ...job.metadata.durableEffectReceipt,
        confirmation_pending: 'unknown',
      },
    },
  };
  expect(
    resolveCurrentDurableWorkReceipt({
      job: malformed,
      responseMessageId: 'answer',
      sourceEventId: 'source',
      requireSuperseded: false,
    }),
  ).toEqual({ receipt: null, rejectionReason: 'receipt_shape_invalid' });
});
