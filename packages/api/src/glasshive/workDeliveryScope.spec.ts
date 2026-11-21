import { projectWorkResultObservation } from './workDeliveryScope';
import { projectActiveWorkRoster, formatActiveWorkContext } from './activeWorkContext';
import { normalizeWorkDeliveryScope } from './workDeliveryScope';

describe('work delivery scope', () => {
  it('preserves another conversation and retained run without claiming current delivery', () => {
    expect(
      normalizeWorkDeliveryScope({
        originConversationId: 'prior-chat',
        destinations: ['telegram', 'librechat'],
        resultRunId: 'prior-run',
        resultRevision: 2,
      }),
    ).toEqual({
      originConversationId: 'prior-chat',
      destinations: ['telegram', 'librechat'],
      resultRunId: 'prior-run',
      resultRevision: 2,
    });
  });
  it('keeps unknown destinations distinct from a known empty list and drops unsafe fields', () => {
    expect(
      normalizeWorkDeliveryScope({ originConversationId: 'chat-a', secret: 'hidden' }),
    ).toEqual({
      originConversationId: 'chat-a',
      destinations: null,
      resultRunId: null,
      resultRevision: null,
    });
    expect(normalizeWorkDeliveryScope({ destinations: [] })?.destinations).toEqual([]);
    expect(
      normalizeWorkDeliveryScope({
        destinations: ['telegram', 'telegram'],
        resultRevision: -1,
      })?.destinations,
    ).toEqual(['telegram']);
    expect(
      normalizeWorkDeliveryScope({ originConversationId: 'chat-a', destinations: ['private-url'] })
        ?.destinations,
    ).toBeNull();
    expect(normalizeWorkDeliveryScope({ originConversationId: 'invalid\nidentity' })).toBeNull();
    expect(normalizeWorkDeliveryScope(null)).toBeNull();
  });
});

describe('work result observation', () => {
  const row = {
    workRef: 'work-a',
    title: 'Create several files',
    state: 'completed',
    delivery: { state: 'delivered', unreadTerminal: false },
    deliveryScope: {
      originConversationId: 'origin-chat',
      destinations: ['telegram'],
      resultRunId: 'run-a',
      resultRevision: 2,
      privateField: 'excluded-secret',
    },
  };
  it('separates execution and a result-message receipt from artifact delivery', () => {
    const result = projectWorkResultObservation(row);
    expect(result).toMatchObject({
      execution: { state: 'completed' },
      result: {
        bodyIncluded: false,
        readerArguments: { scope: 'result', workRef: 'work-a', runId: 'run-a' },
        revision: 2,
      },
      presentationReceipt: {
        scope: 'result_message',
        state: 'delivered',
        deliveryScope: {
          originConversationId: 'origin-chat',
          resultRunId: 'run-a',
          resultRevision: 2,
        },
      },
      artifactDelivery: { state: 'unknown' },
    });
    expect(JSON.stringify(result)).not.toContain('excluded-secret');
    expect(result).not.toHaveProperty('deliveryState');
  });
  it('keeps a prior result independent of current execution and missing scope unknown', () => {
    expect(projectWorkResultObservation({ ...row, state: 'running' })).toMatchObject({
      execution: { state: 'running' },
      result: { readerArguments: { runId: 'run-a' } },
      presentationReceipt: { state: 'delivered' },
      artifactDelivery: { state: 'unknown' },
    });
    expect(projectWorkResultObservation({ workRef: 'work-a', state: 'failed' })).toMatchObject({
      execution: { state: 'failed' },
      result: { readerArguments: { scope: 'result', workRef: 'work-a' } },
      presentationReceipt: { state: 'unknown' },
      artifactDelivery: { state: 'unknown' },
    });
  });
  it('retains exact reader identity and receipt meaning in tool, Voice and text observations', () => {
    const snapshot = { snapshot: 'fresh', work: [row], overflowCount: 0 };
    const tool = projectActiveWorkRoster(snapshot, 'history');
    const observations = [
      tool.work[0],
      ...[true, false].map((voice) => {
        const rendered = formatActiveWorkContext({
          snapshot,
          preferredMode: 'parallel',
          available: true,
          voice,
        });
        return JSON.parse(rendered.slice(rendered.indexOf('{'))).work[0];
      }),
    ];
    for (const item of observations) {
      expect(item).toMatchObject({
        workRef: 'work-a',
        execution: { state: 'completed' },
        result: {
          readerArguments: { scope: 'result', workRef: 'work-a', runId: 'run-a' },
          revision: 2,
        },
        presentationReceipt: { scope: 'result_message', state: 'delivered' },
        artifactDelivery: { state: 'unknown' },
      });
      expect(item).not.toHaveProperty('deliveryState');
    }
  });
});
