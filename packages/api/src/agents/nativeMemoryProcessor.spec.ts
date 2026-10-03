/* === VIVENTIUM START === Exercise the native writer through the actual memory processor. === */
import { Run, Providers } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { Tools } from 'librechat-data-provider';
import type { Response } from 'express';
import type { createRun } from './run';
import type { NativeMemoryToolBinding } from './nativeMemoryWriter';
import { createNativeMemoryExecutor } from './nativeMemoryWriter';
import { createMemoryProcessor, processMemory } from './memory';

jest.mock('~/stream/GenerationJobManager');
jest.mock('~/utils', () => ({
  Tokenizer: { getTokenCount: (text: string) => text.length },
  createSafeUser: (user: object) => user,
  resolveHeaders: ({ headers }: { headers: object }) => headers,
}));
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  Run: {
    create: jest.fn(async () => ({ processStream: jest.fn(async () => 'direct') })),
  },
}));

const identity = {
  userId: 'writer-owner',
  messageId: 'writer-answer',
  conversationId: 'writer-conversation',
  owner: 'writer-process',
};
type Operations = {
  operations: Array<{
    action: 'set' | 'delete' | 'noop';
    key?: string;
    value?: string;
    reason?: string;
  }>;
};

function fixture({
  operations = { operations: [{ action: 'noop', reason: 'No durable fact.' }] },
  failure,
  failAfterEffect = false,
  repeat = false,
}: {
  operations?: Operations;
  failure?: Error;
  failAfterEffect?: boolean;
  repeat?: boolean;
} = {}) {
  const authorize = jest.fn(async () => undefined);
  const unregister = jest.fn();
  let binding: NativeMemoryToolBinding;
  const register = jest.fn((value: NativeMemoryToolBinding) => {
    binding = value;
    return unregister;
  });
  const buildBundle = jest.fn(async () => ({ glasshive_capability_broker: {} }));
  const attachBundle = jest.fn(() => true);
  const invoke = async () => {
    const grant = {
      user_id: identity.userId,
      message_id: identity.messageId,
      conversation_id: identity.conversationId,
      allowed_servers: [],
      allowed_host_tools: ['apply_memory_changes'],
      allow_dynamic_policy_servers: false,
      host_tool_resources: { apply_memory_changes: binding.resource },
    };
    await binding.invoke(grant, operations);
    if (repeat) await binding.invoke(grant, operations);
  };
  const createProviderRunMock = jest.fn(async (_config: Parameters<typeof createRun>[0]) => ({
    processStream: jest.fn(async () => {
      if (failure && !failAfterEffect) throw failure;
      await invoke();
      if (failure) throw failure;
    }),
  }));
  const executor = createNativeMemoryExecutor({
    identity,
    agent: {
      id: 'native-writer',
      provider: Providers.OPENAI,
      model: 'codex-cli:gpt-6.1-sol',
      model_parameters: { reasoning_effort: 'high' },
    } as Parameters<typeof createRun>[0]['agents'][number],
    user: { id: identity.userId } as Parameters<typeof createRun>[0]['user'],
    requestBody: {},
    authorize,
    register,
    buildBundle,
    attachBundle,
    createProviderRun: createProviderRunMock as unknown as typeof createRun,
  });
  const setMemory: jest.Mock = jest.fn(async () => ({
    ok: true,
    changed: true,
    memory: { __v: 8 },
  }));
  const deleteMemory = jest.fn(async () => ({ ok: true, changed: true }));
  const params: Parameters<typeof processMemory>[0] = {
    res: { headersSent: false, write: jest.fn() } as unknown as Response,
    userId: identity.userId,
    messageId: identity.messageId,
    conversationId: identity.conversationId,
    setMemory,
    deleteMemory,
    messages: [new HumanMessage('Synthetic source turn.')],
    memory: 'preferences: Existing synthetic fact.',
    validKeys: ['preferences', 'context'],
    instructions: 'Existing canonical writer instructions.',
    llmConfig: { provider: Providers.OPENAI, model: 'codex-cli:gpt-6.1-sol' },
    memoryRevisionMap: { preferences: 7 },
    nativeExecutor: executor,
  };
  return {
    params,
    executor,
    register,
    unregister,
    buildBundle,
    attachBundle,
    authorize,
    createProviderRunMock,
    setMemory,
    deleteMemory,
  };
}

describe('native memory processor wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses only the supplied native broker executor for a truthful noop', async () => {
    const f = fixture();
    expect(await processMemory(f.params)).toEqual([]);
    expect(f.createProviderRunMock).toHaveBeenCalledTimes(1);
    expect(f.buildBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHostTools: ['apply_memory_changes'],
        allowedServerNames: [],
      }),
    );
    expect(Run.create).not.toHaveBeenCalled();
    expect(f.setMemory).not.toHaveBeenCalled();
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });

  it('forwards the configured executor and existing context through createMemoryProcessor', async () => {
    const f = fixture();
    const [, writer] = await createMemoryProcessor({
      res: f.params.res,
      userId: identity.userId,
      messageId: identity.messageId,
      conversationId: identity.conversationId,
      config: {
        nativeExecutor: f.executor,
        validKeys: f.params.validKeys,
        instructions: f.params.instructions,
        llmConfig: f.params.llmConfig,
      },
      memoryMethods: {
        setMemory: f.setMemory,
        deleteMemory: f.deleteMemory,
        getFormattedMemories: jest.fn(),
        getAllUserMemories: jest.fn(),
        getAllUserMemoryStates: jest.fn(),
      },
      snapshot: {
        withKeys: f.params.memory,
        withoutKeys: 'Existing synthetic fact.',
        totalTokens: 0,
        memoryTokenMap: {},
        memoryRevisionMap: { preferences: 7 },
        memoryValueHashMap: {},
      },
    });
    expect(await writer(f.params.messages)).toEqual([]);
    expect(f.createProviderRunMock).toHaveBeenCalledTimes(1);
    const nativeConfig = f.createProviderRunMock.mock.calls[0][0] as Parameters<
      typeof createRun
    >[0];
    expect(nativeConfig.agents[0].instructions).toContain(f.params.instructions);
    expect(nativeConfig.agents[0].instructions).toContain(f.params.memory);
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('uses the existing CAS tool and artifact callback exactly once across transport repeats', async () => {
    const f = fixture({
      operations: { operations: [{ action: 'set', key: 'preferences', value: 'A new fact.' }] },
      repeat: true,
    });
    const result = await processMemory(f.params);
    expect(f.setMemory).toHaveBeenCalledTimes(1);
    expect(f.setMemory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: identity.userId, key: 'preferences', expectedRevision: 7 }),
    );
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      messageId: identity.messageId,
      conversationId: identity.conversationId,
      [Tools.memory]: { type: 'update', value: 'A new fact.' },
    });
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('retains a failed CAS result instead of reporting a saved effect', async () => {
    const f = fixture({
      operations: { operations: [{ action: 'set', key: 'preferences', value: 'A new fact.' }] },
    });
    f.setMemory.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: 'memory_revision_conflict',
    });
    const result = await processMemory(f.params);
    expect(f.setMemory).toHaveBeenCalledTimes(1);
    expect(result?.[0]?.[Tools.memory]?.type).toBe('error');
    expect(f.createProviderRunMock).toHaveBeenCalledTimes(1);
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('returns the existing partial-apply artifact without re-running native inference', async () => {
    const f = fixture({
      operations: {
        operations: [
          { action: 'set', key: 'preferences', value: 'One saved fact.' },
          { action: 'set', key: 'context', value: 'A conflicting fact.' },
        ],
      },
    });
    f.setMemory.mockResolvedValueOnce({ ok: true, changed: true, memory: { __v: 8 } });
    f.setMemory.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: 'memory_revision_conflict',
    });
    const result = await processMemory(f.params);
    expect(f.setMemory).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(result?.[0]?.[Tools.memory]?.value))).toMatchObject({
      partialApplied: true,
    });
    expect(f.createProviderRunMock).toHaveBeenCalledTimes(1);
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('returns provider failure truth before the tool, without direct fallback or a write', async () => {
    const f = fixture({
      failure: Object.assign(new Error('Synthetic provider quota'), {
        status: 429,
        code: 'usage_limit_reached',
      }),
    });
    const result = await processMemory(f.params);
    expect(result?.[0]?.[Tools.memory]?.type).toBe('error');
    expect(JSON.parse(String(result?.[0]?.[Tools.memory]?.value))).toMatchObject({
      errorType: 'usage_limit_reached',
    });
    expect(JSON.parse(String(result?.[0]?.[Tools.memory]?.value)).partialApplied).not.toBe(true);
    expect(f.setMemory).not.toHaveBeenCalled();
    expect(f.unregister).toHaveBeenCalledTimes(1);
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('keeps the completed effect and honest error after a post-tool transport failure', async () => {
    const f = fixture({
      operations: { operations: [{ action: 'set', key: 'preferences', value: 'A new fact.' }] },
      failure: new Error('Synthetic transport failure'),
      failAfterEffect: true,
    });
    const result = await processMemory(f.params);
    expect(f.setMemory).toHaveBeenCalledTimes(1);
    expect(result?.map((item) => item?.[Tools.memory]?.type)).toEqual(['update', 'error']);
    expect(JSON.parse(String(result?.[1]?.[Tools.memory]?.value))).toMatchObject({
      partialApplied: true,
    });
    expect(f.createProviderRunMock).toHaveBeenCalledTimes(1);
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('preserves the direct API graph when no native executor is supplied', async () => {
    const f = fixture();
    const { nativeExecutor, ...direct } = f.params;
    void nativeExecutor;
    await processMemory(direct);
    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(f.createProviderRunMock).not.toHaveBeenCalled();
    expect((Run.create as jest.Mock).mock.calls[0][0].graphConfig.tools).toHaveLength(4);
  });
});
/* === VIVENTIUM END === */
