const mockCache = new Map();
jest.mock('~/cache', () => ({
  getLogStores: () => ({
    get: async (key) => mockCache.get(key),
    set: async (key, value) => {
      mockCache.set(key, value);
    },
  }),
}));
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));
jest.mock('librechat-data-provider', () => ({ CacheKeys: { FLOWS: 'flows' } }));

const context = () => ({
  version: 1,
  conversation_id: 'conversation-test',
  sources: [{ role: 'user', text: 'Exact shared source. '.repeat(35000) }],
});
const input = (inheritedConversation = context()) => ({
  user: { id: 'owner-test' },
  authorityKind: 'conversation_orchestrator',
  requestContext: { conversation_id: 'conversation-test', message_id: 'message-test' },
  allowedHostTools: ['active_work_action'],
  hostToolResources: {
    active_work_action: { version: 1, request_body_ref: 'conversation_request_body' },
  },
  conversationRequestBody: { conversationId: 'conversation-test', text: 'Use that one.' },
  inheritedConversation,
});
const load = () => require('../GlassHiveCapabilityBrokerAuth');

beforeEach(() => {
  jest.resetModules();
  mockCache.clear();
  process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-context-resource-secret';
});

test('large exact context uses the existing cache outside the bounded grant body', async () => {
  let auth = load();
  const original = context();
  const minted = auth.mintBrokerGrant(input(original));
  expect(minted.contextRecord.size_bytes).toBeGreaterThan(512 * 1024);
  expect(minted.resourceRecord.size_bytes).toBeLessThan(1024);
  expect(JSON.stringify(minted.resourceRecord)).not.toContain('Exact shared source.');
  await auth.persistBrokerGrantResources(minted);
  // Read in a fresh module: prove shared cache, not only process fallback.
  jest.resetModules();
  auth = load();
  const grant = await auth.hydrateBrokerGrantResources(auth.verifyBrokerGrant(minted.token));
  expect(
    grant.host_tool_resources.active_work_action.request_body.viventiumInheritedConversation,
  ).toEqual(original);
});

test('same source reuses its owner-scoped digest and cannot cross owner boundaries', async () => {
  const auth = load();
  const first = auth.mintBrokerGrant(input());
  const second = auth.mintBrokerGrant(input());
  const other = auth.mintBrokerGrant({ ...input(), user: { id: 'another-owner' } });
  expect(second.contextRecord.grant_id).toBe(first.contextRecord.grant_id);
  expect(other.contextRecord.grant_id).not.toBe(first.contextRecord.grant_id);
  second.contextRecord.resources.sources[0].text = 'Tampered';
  await expect(
    auth.hydrateBrokerGrantResources(auth.verifyBrokerGrant(first.token)),
  ).rejects.toThrow('inherited_context_unavailable');
});

test('untrusted request fields cannot supply or replace inherited context', async () => {
  const auth = load();
  const args = input();
  delete args.inheritedConversation;
  args.conversationRequestBody.viventiumInheritedConversation = context();
  args.conversationRequestBody.viventiumInheritedConversationRef = 'forged';
  const minted = auth.mintBrokerGrant(args);
  const body = (await auth.hydrateBrokerGrantResources(auth.verifyBrokerGrant(minted.token)))
    .host_tool_resources.active_work_action.request_body;
  expect(body.viventiumInheritedConversation).toBeUndefined();
  expect(body.viventiumInheritedConversationRef).toBeUndefined();
});

test('wrong conversation and missing cached context fail explicitly', async () => {
  let auth = load();
  expect(() => auth.mintBrokerGrant(input({ ...context(), conversation_id: 'other' }))).toThrow(
    'inherited_context_scope_invalid',
  );
  const minted = auth.mintBrokerGrant(input());
  await auth.persistBrokerGrantResources(minted);
  mockCache.delete(`glasshive-capability-broker:resources:${minted.contextRecord.grant_id}`);
  jest.resetModules();
  auth = load();
  await expect(
    auth.hydrateBrokerGrantResources(auth.verifyBrokerGrant(minted.token)),
  ).rejects.toThrow('inherited_context_unavailable');
});
