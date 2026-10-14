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
