import { createNativeVoiceInputClient } from './nativeVoiceInput';

const input = {
  requestId: 'request-a',
  requestFingerprint: 'a'.repeat(64),
  runId: 'run-a',
  attemptId: 'attempt-a',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  prompt: 'Write the requested file',
  choices: [
    { value: 'allow-a', label: 'Allow once' },
    { value: 'deny-a', label: 'Deny' },
  ],
};
const setup = () => {
  const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
  return {
    fetchImpl,
    client: createNativeVoiceInputClient({
      baseURL: 'http://native.test/v1',
      apiKey: 'synthetic-key',
      userId: 'owner-a',
      fetchImpl,
    }),
  };
};

describe('Native Voice input transport', () => {
  it('uses the configured provider, owner, and exact response key without putting secrets in the URL', async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ version: 1, accepted: true, requestId: 'request-a' })),
    );
    await expect(client.submit('response:a', input, 'allow-a')).resolves.toEqual({
      accepted: true,
      phase: 'running',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://native.test/v1/requests/by-idempotency/response%3Aa/native-input',
    );
    const options = fetchImpl.mock.calls[0][1];
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer synthetic-key',
      'X-Viventium-User-Id': 'owner-a',
    });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      requestFingerprint: input.requestFingerprint,
      runId: 'run-a',
      attemptId: 'attempt-a',
      input: 'allow-a',
    });
  });

  it('does not send expired or unoffered input', async () => {
    const { fetchImpl, client } = setup();
    await expect(client.submit('key', input, 'invented')).rejects.toThrow();
    await expect(
      client.submit('key', { ...input, expiresAt: new Date(0).toISOString() }, 'allow-a'),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires the native acknowledgement for this exact request', async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ version: 1, accepted: true, requestId: 'another' })),
    );
    await expect(client.submit('key', input, 'allow-a')).rejects.toThrow(
      'native_input_not_acknowledged',
    );
  });

  it('publishes each native request once and stops at terminal state', async () => {
    const { fetchImpl, client } = setup();
    const onInput = jest.fn();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, state: 'running', pending: [input, input] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 1, state: 'completed', pending: [] })),
      );
    await client.poll({
      key: () => 'exact-key',
      signal: new AbortController().signal,
      isActive: () => true,
      onInput,
    });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(input, 'exact-key');
  });
});

test('queues simultaneous native requests without replacing an unanswered request', async () => {
  const next = { ...input, requestId: 'request-next', requestFingerprint: 'b'.repeat(64) };
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 1, state: 'running', pending: [input, next] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 1, state: 'running', pending: [input, next] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 1, state: 'running', pending: [next] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ version: 1, state: 'completed', pending: [] })),
    );
  const onInput = jest.fn();
  await createNativeVoiceInputClient({
    baseURL: 'http://native.local/v1',
    apiKey: 'synthetic-key',
    userId: 'owner',
    fetchImpl,
  }).poll({
    key: () => 'exact',
    signal: new AbortController().signal,
    isActive: () => true,
    onInput,
  });
  expect(onInput.mock.calls.map(([input]) => input.requestId)).toEqual([
    input.requestId,
    next.requestId,
  ]);
});
