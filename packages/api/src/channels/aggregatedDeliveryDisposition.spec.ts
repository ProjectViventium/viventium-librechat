import { createContentAggregator, GraphEvents } from '@librechat/agents';
import { retainAggregatedDeliveryDisposition } from './deliveryDisposition';
import type { DeliveryDisposition } from './deliveryDisposition';

const decision = (audio: 'eligible' | 'skip'): DeliveryDisposition => ({
  version: 1,
  audio,
  source: 'model',
  valid: true,
  required: true,
});

function aggregate() {
  const native = createContentAggregator();
  const feed = (event: Parameters<typeof native.aggregateContent>[0]) => {
    const before = native.contentParts.slice();
    native.aggregateContent(event);
    retainAggregatedDeliveryDisposition(native.contentParts, before, event);
  };
  const step = (id: string, index: number, agentId = 'main') =>
    feed({
      event: GraphEvents.ON_RUN_STEP,
      data: { id, index, agentId, stepDetails: { type: 'message_creation' } },
    });
  const delta = (id: string, text: string, disposition: unknown) =>
    feed({
      event: GraphEvents.ON_MESSAGE_DELTA,
      data: {
        id,
        delta: {
          content: [{ type: 'text', text }],
          metadata: { viventium: { deliveryDisposition: disposition } },
        },
      },
    });
  return { ...native, step, delta };
}

describe('aggregated per-envelope audio delivery', () => {
  it.each([
    ['eligible', 'skip'],
    ['skip', 'eligible'],
  ] as const)('retains %s then %s on one native message index', (first, second) => {
    const t = aggregate();
    t.step('main-native', 0);
    t.delta('main-native', 'Update 🟢. ', decision(first));
    // An internal native tool emits provider activity, then its terminal envelope
    // returns through the same graph message creation step.
    t.delta('main-native', 'Result.', decision(second));
    expect(t.contentParts).toEqual([
      {
        type: 'text',
        agentId: 'main',
        text: 'Update 🟢. Result.',
        deliveryDispositionRanges: [
          { start: 0, end: 11, disposition: decision(first) },
          { start: 11, end: 18, disposition: decision(second) },
        ],
      },
    ]);
  });
  it.each([
    ['eligible', 'skip'],
    ['skip', 'eligible'],
  ] as const)('keeps separate Main graph parts isolated for %s then %s', (first, second) => {
    const t = aggregate();
    t.step('main-before', 0);
    t.step('main-after', 1);
    t.delta('main-before', 'Update.', decision(first));
    t.delta('main-after', 'Result.', decision(second));
    expect(t.contentParts).toEqual([
      {
        type: 'text',
        agentId: 'main',
        text: 'Update.',
        deliveryDispositionRanges: [{ start: 0, end: 7, disposition: decision(first) }],
      },
      {
        type: 'text',
        agentId: 'main',
        text: 'Result.',
        deliveryDispositionRanges: [{ start: 0, end: 7, disposition: decision(second) }],
      },
    ]);
  });
  it('coalesces consecutive identical choices and retains them across unknown deltas', () => {
    const t = aggregate();
    t.step('main', 0);
    t.delta('main', 'A', decision('skip'));
    t.delta('main', 'B', decision('skip'));
    t.delta('main', 'C', { ...decision('eligible'), source: 'untrusted' });
    expect(t.contentParts[0]).toMatchObject({
      text: 'ABC',
      deliveryDispositionRanges: [{ start: 0, end: 2, disposition: decision('skip') }],
    });
  });
  it.each(['required_missing', 'required_malformed', 'legacy_marker'])(
    'retains Core silence from %s without granting audio authority',
    (source) => {
      const t = aggregate();
      t.step('main', 0);
      const skip = { ...decision('skip'), source, valid: source === 'legacy_marker' };
      t.delta('main', 'Silent.', skip);
      expect(t.contentParts[0]).toMatchObject({
        deliveryDispositionRanges: [{ start: 0, end: 7, disposition: skip }],
      });
      t.delta('main', 'Default.', { ...skip, audio: 'eligible' });
      expect(t.contentParts[0]).toMatchObject({
        deliveryDispositionRanges: [{ start: 0, end: 7, disposition: skip }],
      });
    },
  );
  it.each(['agentId', 'groupId'])(
    'does not inherit an audible range from a changed %s',
    (identity) => {
      const old = {
        type: 'text',
        text: 'Old.',
        agentId: 'main',
        groupId: 'old',
        sourceStepId: 'old',
        deliveryDispositionRanges: [{ start: 0, end: 4, disposition: decision('eligible') }],
      };
      const current = {
        type: 'text',
        text: 'Old.New.',
        agentId: 'main',
        groupId: 'old',
        sourceStepId: 'old',
        [identity]: 'new',
      };
      retainAggregatedDeliveryDisposition([current], [old], {
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: 'New.' }],
            metadata: { viventium: { deliveryDisposition: decision('skip') } },
          },
        },
      });
      expect(current).not.toHaveProperty('deliveryDispositionRanges');
    },
  );
  it('does not carry a prior decision into a replacement rather than an appended answer', () => {
    const current = { type: 'text', text: 'Replacement.' };
    retainAggregatedDeliveryDisposition(
      [current],
      [
        {
          type: 'text',
          text: 'Old.',
          deliveryDispositionRanges: [{ start: 0, end: 4, disposition: decision('eligible') }],
        },
      ],
      {
        event: 'on_message_delta',
        data: { delta: { content: [{ type: 'text', text: 'Replacement.' }] } },
      },
    );
    expect(current).not.toHaveProperty('deliveryDispositionRanges');
  });

  it('retains choices when the SDK recreates a previously repaired part without repair-only metadata', () => {
    const before = {
      type: 'text',
      agentId: 'main',
      text: 'Update.',
      sourceStepId: 'main-step',
      deliveryDispositionRanges: [{ start: 0, end: 7, disposition: decision('eligible') }],
    };
    const current = { type: 'text', agentId: 'main', text: 'Update.Result.' };
    retainAggregatedDeliveryDisposition([current], [before], {
      event: 'on_message_delta',
      data: {
        id: 'main-step',
        delta: {
          content: [{ type: 'text', text: 'Result.' }],
          metadata: { viventium: { deliveryDisposition: decision('skip') } },
        },
      },
    });
    expect(current).toHaveProperty('deliveryDispositionRanges', [
      { start: 0, end: 7, disposition: decision('eligible') },
      { start: 7, end: 14, disposition: decision('skip') },
    ]);
  });
});
