import { createNativeVoiceInputClient } from './nativeVoiceInput';
import type { NativeVoiceInput } from './nativeVoiceInput';

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

const questionKey = 'Which colour?\nKeep exact spacing ';
const questionInput = (): Extract<NativeVoiceInput, {kind: 'question'}> => ({
  requestId: input.requestId, requestFingerprint: input.requestFingerprint,
  runId: input.runId, attemptId: input.attemptId, expiresAt: input.expiresAt,
  prompt: questionKey, kind: 'question', requestedSchema: {
    type: 'object', required: ['answers'], additionalProperties: false,
    properties: {
      answers: {type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 16,
        properties: {[questionKey]: {type: 'array', uniqueItems: true, minItems: 1, maxItems: 1,
          items: {type: 'string', enum: ['Blue', 'Red', 'Other']}}}},
      annotations: {type: 'object', additionalProperties: false,
        properties: {[questionKey]: {type: 'object', additionalProperties: false, required: ['notes'],
          properties: {notes: {type: 'string', minLength: 1, maxLength: 8000}}}}},
    },
  },
});

describe('Native Voice input transport', () => {
  it.each(['answered','replaced','expired','terminal','current'])('fresh native ownership rejects stale %s snapshot speech', async (state) => {
    const {fetchImpl,client}=setup(); const request=questionInput();
    const pending=state==='answered' ? [] : [{...request,
      ...(state==='replaced' ? {requestFingerprint:'b'.repeat(64)} : {}),
      ...(state==='expired' ? {expiresAt:new Date(0).toISOString()} : {})}];
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({version:1,state:state==='terminal' ? 'completed' : 'running',pending})));
    await expect(client.isCurrent('exact-question',request)).resolves.toBe(state==='current');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({'X-Viventium-User-Id':'owner-a'});
    expect(fetchImpl.mock.calls[0][1]?.method).toBeUndefined();
  });
  it('returns exact clarification keys and freeform notes through the existing owner endpoint', async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({version: 1, accepted: true, requestId: input.requestId})));
    const answer = {answers: {[questionKey]: ['Other']}, annotations: {[questionKey]: {notes: 'Green  with exact spacing'}}};
    await expect(client.submit('response:question', questionInput(), JSON.stringify(answer))).resolves.toEqual({accepted: true, phase: 'running'});
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input)).toEqual(answer);
    expect(body.requestFingerprint).toBe(input.requestFingerprint);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({'X-Viventium-User-Id': 'owner-a'});
  });

  it('rejects invented labels, multiple single-select answers and wrong native keys before transport', async () => {
    const { fetchImpl, client } = setup();
    for (const content of [
      {answers: {[questionKey]: ['blue']}},
      {answers: {[questionKey]: ['Blue', 'Red']}},
      {answers: {'Which colour?': ['Blue']}},
      {answers: {[questionKey]: ['Blue']}, annotations: {[questionKey]: {notes: 'not an Other answer'}}},
    ]) await expect(client.submit('key', questionInput(), JSON.stringify(content))).rejects.toThrow('native_input_invalid_or_expired');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('polls a typed clarification once without requiring permission choices', async () => {
    const { fetchImpl, client } = setup();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({version: 1, state: 'running', pending: [questionInput()]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({version: 1, state: 'completed', pending: []})));
    const onInput = jest.fn();
    await client.poll({key: () => 'question-key', signal: new AbortController().signal, isActive: () => true, onInput});
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput.mock.calls[0][0]).toMatchObject({kind: 'question', requestedSchema: questionInput().requestedSchema});
  });
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

it('retains bounded permission operation detail without changing the spoken prompt', async () => {
  const {fetchImpl, client}=setup();
  const request={...input,operationTitle:'Create synthetic.txt in the working folder.'};
  fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({version:1,state:'running',pending:[request]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({version:1,state:'completed',pending:[]})));
  const onInput=jest.fn();
  await client.poll({key:()=> 'key',signal:new AbortController().signal,isActive:()=>true,onInput});
  expect(onInput).toHaveBeenCalledWith(request,'key');
});
it.each(['x'.repeat(8001),42])('rejects invalid permission operation detail before presentation', async (operationTitle) => {
  const {fetchImpl,client}=setup(); const onInput=jest.fn();
  fetchImpl.mockResolvedValue(new Response(JSON.stringify({version:1,state:'running',pending:[{...input,operationTitle}]})));
  await expect(client.poll({key:()=> 'key',signal:new AbortController().signal,isActive:()=>true,onInput})).rejects.toThrow();
  expect(onInput).not.toHaveBeenCalled();
});
