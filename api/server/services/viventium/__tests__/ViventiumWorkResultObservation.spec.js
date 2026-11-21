/* === VIVENTIUM START === Typed work observation consumer proof. === */
jest.mock('../ViventiumOrchestrationMode', () => ({}), { virtual: true });
const { buildActiveWorkCapsule } = require('../ViventiumDynamicTurnContext');
const decode = (value) =>
  JSON.parse(
    value
      .split('<viventium_untrusted_active_work_data encoding="json-v1">')[1]
      .split('</viventium_untrusted_active_work_data>')[0],
  );

describe('work result observation', () => {
  const row = {
    workRef: 'work-a',
    title: 'Create several files',
    state: 'completed',
    statusSummary: 'Completed',
    delivery: { state: 'delivered', unreadTerminal: false },
    deliveryScope: {
      originConversationId: 'other-chat',
      destinations: ['telegram'],
      resultRunId: 'run-a',
      resultRevision: 3,
    },
  };
  it('keeps scheduler/Main observations explicit about what the receipt confirms', () => {
    const item = decode(
      buildActiveWorkCapsule({ mode: 'parallel', snapshot: { snapshot: 'fresh', work: [row] } }),
    ).work[0];
    expect(item).toMatchObject({
      workRef: 'work-a',
      execution: { state: 'completed', status: 'Completed' },
      result: {
        bodyIncluded: false,
        readerArguments: { scope: 'result', workRef: 'work-a', runId: 'run-a' },
        revision: 3,
      },
      presentationReceipt: {
        scope: 'result_message',
        state: 'delivered',
        deliveryScope: { originConversationId: 'other-chat' },
      },
      artifactDelivery: { state: 'unknown' },
    });
    expect(item).not.toHaveProperty('delivery');
    expect(item).not.toHaveProperty('deliveryState');
    expect(item).not.toHaveProperty('status');
  });
  it('retains independent current execution, controls and unknown result scope', () => {
    const item = decode(
      buildActiveWorkCapsule({
        mode: 'parallel',
        snapshot: {
          snapshot: 'fresh',
          work: [
            {
              workRef: 'work-b',
              state: 'running',
              actions: ['message', 'stop'],
              delivery: { state: 'pending' },
            },
          ],
        },
      }),
    ).work[0];
    expect(item).toMatchObject({
      workRef: 'work-b',
      execution: { state: 'running' },
      actions: ['message', 'stop'],
      result: { readerArguments: { scope: 'result', workRef: 'work-b' } },
      presentationReceipt: { scope: 'result_message', state: 'pending' },
      artifactDelivery: { state: 'unknown' },
    });
    expect(item.result.readerArguments).not.toHaveProperty('runId');
    expect(item.result).not.toHaveProperty('revision');
  });
});

/* === VIVENTIUM END === */
