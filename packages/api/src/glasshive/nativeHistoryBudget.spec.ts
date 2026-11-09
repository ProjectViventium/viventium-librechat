import type { NativeResponseAdmission } from '@librechat/data-schemas';
import type { NativeResult } from './nativeResponse';
import { readNativeConversationHistoryBudget } from './nativeHistoryBudget';

const identity: NativeResponseAdmission = {
  userId: 'owner',
  conversationId: 'conversation',
  responseMessageId: 'answer',
  streamId: 'stream',
  jobCreatedAt: 1,
  logicalTurnId: 'scope.turn',
  revision: 1,
  invocationId: 'invocation',
  providerId: 'native',
  agentId: 'agent',
  bodySha256: 'a'.repeat(64),
  originSha256: 'b'.repeat(64),
  source: { id: 'source', messageId: 'question', digest: 'c'.repeat(64) },
  admittedAt: 2,
  recoverUntil: 9999999999999,
  status: 'completed',
};
const result: NativeResult = {
  version: 1,
  object: 'glasshive.request.result',
  state: 'completed',
  invocation_id: identity.invocationId,
  stream_id: identity.streamId,
  message_id: identity.responseMessageId,
  body_sha256: identity.bodySha256,
  authority_sha256: 'd'.repeat(64),
  agent_id: identity.agentId,
  conversation_id: identity.conversationId,
  request_id: 'request',
  run_id: 'run',
  native_history_budget_v1: {
    version: 1,
    model_id: 'selected-model',
    stable_authority_sha256: 'epoch',
    native_context_epoch: '',
    replay_budget_bytes: 487824,
  },
};
const fixture = () => ({
  ownerId: 'owner',
  conversationId: 'conversation',
  agentId: 'agent',
  contextEpoch: 'epoch',
  modelId: 'selected-model',
  messages: [
    { messageId: 'answer', isCreatedByUser: false },
    { messageId: 'new-question', isCreatedByUser: true },
  ],
  readAdmission: jest.fn(
    async (_ownerId: string, _messageId: string): Promise<NativeResponseAdmission | null> =>
      identity,
  ),
  readResult: jest.fn(async () => result),
});

test('uses the exact owner-scoped observed budget without starting or changing work', async () => {
  const input = fixture();
  expect(await readNativeConversationHistoryBudget(input)).toEqual({
    providerId: 'native',
    modelId: 'selected-model',
    budgetBytes: 487824,
  });
  expect(input.readAdmission).toHaveBeenCalledWith('owner', 'answer');
  expect(input.readResult).toHaveBeenCalledTimes(1);
  expect(input.readResult).toHaveBeenCalledWith(identity);
});

test.each(['userId', 'conversationId', 'agentId', 'responseMessageId'] as const)(
  'never reads a foreign %s result',
  async (field) => {
    const input = fixture();
    input.readAdmission.mockResolvedValue({ ...identity, [field]: 'foreign' });
    expect(await readNativeConversationHistoryBudget(input)).toBeNull();
    expect(input.readResult).not.toHaveBeenCalled();
  },
);

test('accepts a larger exact native capacity receipt without an application byte ceiling', async () => {
  const input = fixture();
  input.readResult.mockResolvedValue({ ...result,
    native_history_budget_v1: { ...result.native_history_budget_v1!, replay_budget_bytes: 2 * 1024 * 1024 } });
  expect(await readNativeConversationHistoryBudget(input)).toMatchObject({ budgetBytes: 2 * 1024 * 1024 });
});

test.each([
  { model_id: 'different-model' },
  { stable_authority_sha256: 'changed-authority' },
  { replay_budget_bytes: 0 },
  { replay_budget_bytes: Number.MAX_SAFE_INTEGER + 1 },
  { replay_budget_bytes: 1.5 },
])('rejects incompatible capacity %j', async (change) => {
  const input = fixture();
  input.readResult.mockResolvedValue({
    ...result,
    native_history_budget_v1: { ...result.native_history_budget_v1!, ...change },
  });
  expect(await readNativeConversationHistoryBudget(input)).toBeNull();
});

test('rejects a result for another invocation and retains old-server compatibility', async () => {
  const input = fixture();
  input.readResult
    .mockResolvedValueOnce({ ...result, invocation_id: 'another' })
    .mockResolvedValueOnce({ ...result, native_history_budget_v1: undefined });
  expect(await readNativeConversationHistoryBudget(input)).toBeNull();
  expect(await readNativeConversationHistoryBudget(input)).toBeNull();
});

test('request cancellation releases a blocked admission lookup', async () => {
  const input = fixture();
  const controller = new AbortController();
  input.readAdmission.mockImplementation(() => new Promise(() => {}));
  const reading = readNativeConversationHistoryBudget({ ...input, signal: controller.signal });
  controller.abort();
  await expect(reading).resolves.toBeNull();
  expect(input.readResult).not.toHaveBeenCalled();
});

test('failed placeholders do not hide the last complete native admission', async () => {
  const input = fixture();
  const messages = [
    ...input.messages,
    ...Array.from({ length: 4 }, (_, index) => ({
      messageId: `failed-${index}`,
      isCreatedByUser: false,
      error: true,
    })),
  ];
  expect(await readNativeConversationHistoryBudget({ ...input, messages })).toEqual({
    providerId: 'native',
    modelId: 'selected-model',
    budgetBytes: 487824,
  });
  expect(input.readAdmission).toHaveBeenCalledTimes(1);
});

test('several worker callbacks do not hide the last completed native conversation admission', async () => {
  const input = fixture();
  input.readAdmission.mockImplementation(async (_owner, messageId) =>
    messageId === identity.responseMessageId ? identity : null,
  );
  const messages = [
    ...input.messages,
    ...Array.from({ length: 5 }, (_, index) => ({
      messageId: `callback-${index}`,
      isCreatedByUser: false,
    })),
  ];
  expect(await readNativeConversationHistoryBudget({ ...input, messages })).toEqual({
    providerId: 'native',
    modelId: 'selected-model',
    budgetBytes: 487824,
  });
  expect(input.readResult).toHaveBeenCalledTimes(1);
});

test('slow callbacks do not hide the last completed native admission', async () => {
  jest.useFakeTimers();
  try {
    const input = fixture();
    input.readAdmission.mockImplementation(async (_owner, messageId) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return messageId === identity.responseMessageId ? identity : null;
    });
    const messages = [input.messages[0], ...Array.from({ length: 6 }, (_, index) => ({
      messageId: `callback-${index}`, isCreatedByUser: false,
    }))];
    const reading = readNativeConversationHistoryBudget({ ...input, messages });
    await jest.advanceTimersByTimeAsync(700);
    await expect(reading).resolves.toMatchObject({ budgetBytes: 487824 });
    expect(input.readAdmission).toHaveBeenCalledTimes(7);
  } finally {
    jest.useRealTimers();
  }
});

test('retains valid native capacity when the authenticated result takes longer than 500 ms', async () => {
  jest.useFakeTimers();
  try {
    const input = fixture();
    input.readResult.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return result;
    });
    const reading = readNativeConversationHistoryBudget(input);
    await jest.advanceTimersByTimeAsync(750);
    await expect(reading).resolves.toEqual({
      providerId: 'native', modelId: 'selected-model', budgetBytes: 487824,
    });
  } finally {
    jest.useRealTimers();
  }
});

test('an unavailable result retains discovery fallback without accepting a receipt', async () => {
  const input = fixture();
  input.readResult.mockRejectedValue(new Error('native_response_lookup_503'));
  await expect(readNativeConversationHistoryBudget(input)).resolves.toBeNull();
});

test('request cancellation releases a pending read-only result lookup', async () => {
  const input = fixture();
  const controller = new AbortController();
  input.readResult.mockImplementation(() => new Promise(() => {}));
  const reading = readNativeConversationHistoryBudget({ ...input, signal: controller.signal });
  await Promise.resolve();
  expect(input.readResult).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(reading).resolves.toBeNull();
});
