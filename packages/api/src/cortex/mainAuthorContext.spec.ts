import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { AppConfig } from '@librechat/data-schemas';
import type { Agent, TMessage } from 'librechat-data-provider';
import { prepareMainAuthorContext } from './mainAuthorContext';
import type { MainAuthorUser } from './mainAuthorContext';

function fixture() {
  const request = {
    body: {
      conversationId: 'conversation',
      text: 'Earlier user input.',
      viventiumGlassHiveTurnContextB64: 'obsolete-turn-context',
      viventiumGlassHiveIdempotencyKey: 'obsolete-request-key',
      streamId: 'old-stream',
      viventiumResultAuthor: { scope: 'forged-scope', messageId: 'forged-message' },
      viventiumStreamId: 'old-foreground-job',
      viventiumLogicalTurnId: 'old-turn',
      viventiumLogicalTurnRevision: 4,
      viventiumAuthoringSourceEventId: 'old-input',
      viventiumAuthoringSourceRevision: 4,
    },
    headers: { 'x-viventium-surface': 'telegram' },
  };
  const input = {
    ownerId: 'owner', conversationId: 'conversation', parentMessageId: 'current-leaf',
    messageId: 'result-event', text: 'Verified result evidence.', request,
    sourceEventId: 'original-source',
    sourceSegments: [{ ordinal: 0, source_index: 0, source_event_id: 'original-source',
      source_message_id: 'original-message', text: 'Original user task.\nKeep exact spacing.  ' }],
    agent: { id: 'main', provider: 'openAI', model: 'synthetic-model',
      model_parameters: { model: 'synthetic-model' }, instructions: 'Current identity.' } as Agent,
    messages: [{ messageId: 'current-leaf', text: 'Original correction.\n'.repeat(200),
      sender: 'User', isCreatedByUser: true }] as TMessage[],
  };
  const client = {
    conversationId: '', responseMessageId: '',
    prepareMainResultContext: jest.fn(async (_messages: TMessage[], _parent: string) => ({
      instructions: 'Prepared Main identity and preferences.', memoryContext: 'Prepared memory.',
      messages: [new HumanMessage(input.text)],
    })),
    sendMessage: jest.fn(), chatCompletion: jest.fn(),
  };
  const deps = {
    readUser: jest.fn(async (_ownerId: string): Promise<MainAuthorUser | null> =>
      ({ id: 'owner', email: 'qa@example.invalid', role: 'USER' })),
    readConfig: jest.fn(async (_role?: string) => ({} as AppConfig)),
    bindRequest: jest.fn(), createClient: jest.fn(async () => client),
  };
  return { input, request, client, deps };
}

test('fresh Main context retains exact history and replaces old invocation carriers', async () => {
  const { input, request, client, deps } = fixture();
  const before = structuredClone(request);
  const result = await prepareMainAuthorContext(input, deps);
  expect(deps.readUser).toHaveBeenCalledWith('owner');
  expect(deps.readConfig).toHaveBeenCalledWith('USER');
  expect(result.req).not.toBe(request);
  expect(result.req.body).not.toHaveProperty('viventiumGlassHiveTurnContextB64');
  expect(result.req.body).not.toHaveProperty('viventiumGlassHiveIdempotencyKey');
  for (const field of ['streamId', 'viventiumResultAuthor', 'viventiumStreamId', 'viventiumLogicalTurnId',
    'viventiumLogicalTurnRevision', 'viventiumAuthoringSourceEventId', 'viventiumAuthoringSourceRevision'])
    expect(result.req.body).not.toHaveProperty(field);
  expect(result.req.body.viventiumTriggeringSourceSegments).toEqual([
    expect.objectContaining({ source_event_id: 'original-source', text: input.sourceSegments[0].text }),
  ]);
  const [messages, leaf] = client.prepareMainResultContext.mock.calls[0];
  expect(leaf).toBe('result-event');
  expect(messages[0]).toEqual(input.messages[0]);
  expect(messages[0]).not.toBe(input.messages[0]);
  expect(messages[1]).toMatchObject({ parentMessageId: 'current-leaf', text: input.text });
  expect(result.req.body.text).toBe(input.sourceSegments[0].text);
  expect(result.req.body.viventiumSourceEventId).toBe('original-source');
  expect(result.req.body.agent_id).toBe(input.agent.id);
  expect(request).toEqual(before);
  expect(client.sendMessage).not.toHaveBeenCalled();
  expect(client.chatCompletion).not.toHaveBeenCalled();
});

test('unavailable Main owner cannot fall back to a generic result author', async () => {
  const { input, deps } = fixture();
  deps.readUser.mockResolvedValueOnce(null);
  await expect(prepareMainAuthorContext(input, deps)).rejects.toThrow('main_author_unavailable');
  expect(deps.createClient).not.toHaveBeenCalled();
});

test('context preparation failure leaves generation and delivery to their existing owner', async () => {
  const { input, client, deps } = fixture();
  client.prepareMainResultContext.mockRejectedValueOnce(new Error('context unavailable'));
  await expect(prepareMainAuthorContext(input, deps)).rejects.toThrow('context unavailable');
  expect(client.sendMessage).not.toHaveBeenCalled();
  expect(client.chatCompletion).not.toHaveBeenCalled();
});
