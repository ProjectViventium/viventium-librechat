import { z } from 'zod';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { createNativeMemoryToolBinding, createNativeMemoryExecutor } from './nativeMemoryWriter';

jest.mock('@librechat/agents', () => ({
  isZodSchema: (schema: unknown) =>
    Boolean(schema && typeof (schema as { parseAsync?: object }).parseAsync === 'function'),
  toJsonSchema: (schema: unknown) => require('zod-to-json-schema').zodToJsonSchema(schema),
}));

const identity = {
  userId: 'owner',
  messageId: 'answer',
  conversationId: 'chat',
  owner: 'process',
};
const operations = {
  operations: [{ action: 'set', key: 'preferences', value: 'Synthetic fact' }],
};
function fixture() {
  const func = jest.fn().mockResolvedValue(['Saved', { memory: { type: 'update' } }]);
  const tool = {
    name: 'apply_memory_changes',
    description: 'Apply one batch.',
    func,
    schema: z.object({
      operations: z
        .array(
          z.object({
            action: z.enum(['set', 'delete', 'noop']),
            key: z.string().optional(),
            value: z.string().optional(),
          }),
        )
        .min(1),
    }),
  } as unknown as DynamicStructuredTool;
  const authorize = jest.fn().mockResolvedValue(undefined);
  const onResult = jest.fn().mockResolvedValue(undefined);
  const binding = createNativeMemoryToolBinding({
    identity,
    tool,
    authorize,
    onResult,
  });
  const grant = {
    user_id: identity.userId,
    message_id: identity.messageId,
    conversation_id: identity.conversationId,
    allowed_servers: [],
    allowed_host_tools: [tool.name],
    allow_dynamic_policy_servers: false,
    host_tool_resources: { [tool.name]: binding.resource },
  };
  return { tool, func, authorize, onResult, binding, grant };
}

describe('admitted native memory tool', () => {
  it.each([
    { user_id: 'other' },
    { message_id: 'other' },
    { conversation_id: 'other' },
    { worker_id: 'mission' },
    { run_id: 'run' },
    { schedule_id: 'schedule' },
    { allowed_servers: ['extra'] },
    { allowed_host_tools: ['apply_memory_changes', 'file_search'] },
    { allow_dynamic_policy_servers: true },
    { host_tool_resources: {} },
  ])('rejects foreign, broad, stale or inherited authority: %j', async (change) => {
    const { binding, grant, func } = fixture();
    await expect(binding.invoke({ ...grant, ...change }, operations)).rejects.toThrow('not_active');
    expect(func).not.toHaveBeenCalled();
  });

  it('applies once; same-argument transport repeats reuse the result, changed repeats fail', async () => {
    const { binding, grant, func, onResult } = fixture();
    const results = await Promise.all([
      binding.invoke(grant, operations),
      binding.invoke(grant, operations),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(func).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    await expect(binding.invoke(grant, { operations: [{ action: 'noop' }] })).rejects.toThrow(
      'already_submitted',
    );
    await binding.finish();
    await expect(binding.invoke(grant, operations)).rejects.toThrow('not_active');
  });

  it('checks current authority even when returning a previous result', async () => {
    const { binding, grant, authorize, func } = fixture();
    await binding.invoke(grant, operations);
    authorize.mockRejectedValue(new Error('permission revoked'));
    await expect(binding.invoke(grant, operations)).rejects.toThrow('permission revoked');
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('drains an already-started apply and receipt while closing further broker calls', async () => {
    const { binding, grant, func, onResult } = fixture();
    let releaseApply: (value: [string, { memory: { type: string } }]) => void;
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    func.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseApply = resolve;
          markStarted();
        }),
    );
    const applying = binding.invoke(grant, operations);
    await started;
    const closed = binding.finish();
    await expect(binding.invoke(grant, operations)).rejects.toThrow('not_active');
    releaseApply!(['Saved', { memory: { type: 'update' } }]);
    await Promise.all([applying, closed]);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('does not accept model prose as a saved-memory result', async () => {
    await expect(fixture().binding.finish()).rejects.toThrow('tool_not_called');
  });

  it('preserves the exact governed partial-write result without retrying it', async () => {
    const { binding, grant, func, onResult } = fixture();
    const partial = [
      'One write failed',
      { memory: { type: 'error', value: '{"partialApplied":true}' } },
    ];
    func.mockResolvedValue(partial);
    expect((await binding.invoke(grant, operations)).result).toBe(partial);
    await binding.invoke(grant, operations);
    expect(func).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(partial, binding.resource.bindingId);
  });
});

describe('native memory inference uses the existing provider run and broker', () => {
  it.each(['ok', 'before', 'after'])(
    'keeps exact route and truthful receipts across provider completion: %s',
    async (outcome) => {
      const { tool, onResult, authorize } = fixture();
      let active: ReturnType<typeof createNativeMemoryToolBinding>;
      const unregister = jest.fn();
      const register = jest.fn((binding) => {
        active = binding;
        return unregister;
      });
      const buildBundle = jest.fn(async (args) => {
        expect(args.allowedHostTools).toEqual([tool.name]);
        expect(args.allowedServerNames).toEqual([]);
        expect(args.requestBody.messageId).toBe(identity.messageId);
        expect(args.requestBody.viventiumGlassHiveTurnContextB64).toBeUndefined();
        expect(args.hostToolResources[tool.name]).toEqual(active.resource);
        return { glasshive_capability_broker: { synthetic: true } };
      });
      const createProviderRun = jest.fn(async (config) => {
        expect(config.agents).toHaveLength(1);
        expect(config.agents[0].tools).toEqual([]);
        expect(config.agents[0].toolDefinitions).toEqual([]);
        expect(config.agents[0].toolRegistry).toBeUndefined();
        expect(config.agents[0].toolContextMap).toBeUndefined();
        expect(config.agents[0].additional_instructions).toBeUndefined();
        expect(config.agents[0].model).toBe('codex-cli:gpt-5.6-luna');
        expect(config.agents[0].model_parameters.reasoning_effort).toBe('medium');
        expect(config.agents[0].viventiumGraphLlmFallbacks).toBeUndefined();
        expect(
          config.agents[0].model_parameters.configuration.defaultHeaders[
            'X-GlassHive-Fallback-Model'
          ],
        ).toBe('');
        expect(config.nativeResponseFetch).toBeUndefined();
        expect(config.requestBody.viventiumGlassHiveTurnContextB64).toBeUndefined();
        expect(config.requestBody.clientTimezone).toBe('UTC');
        return {
          processStream: async () => {
            if (outcome === 'before') throw new Error('provider interrupted before callback');
            await active.invoke(
              {
                user_id: identity.userId,
                message_id: identity.messageId,
                conversation_id: identity.conversationId,
                allowed_servers: [],
                allowed_host_tools: [tool.name],
                allow_dynamic_policy_servers: false,
                host_tool_resources: { [tool.name]: active.resource },
              },
              operations,
            );
            if (outcome === 'after') throw new Error('provider interrupted after callback');
          },
        };
      });
      const executor = createNativeMemoryExecutor({
        identity,
        authorize,
        register,
        buildBundle,
        user: { id: identity.userId } as never,
        requestBody: {viventiumGlassHiveTurnContextB64: 'c3ludGhldGljIG1haW4gY29udGludWl0eQ==', clientTimezone: 'UTC'},
        attachBundle: ({ bundle }) => {
          expect(bundle.provider_capabilities?.native_tools).toBe(false);
          return true;
        },
        agent: {
          id: 'ephemeral',
          provider: 'openai',
          endpoint: 'glasshive-harness',
          model: 'codex-cli:gpt-5.6-luna',
          tools: [],
          model_parameters: {
            model: 'codex-cli:gpt-5.6-luna',
            reasoning_effort: 'medium',
          },
          viventiumGraphLlmFallbacks: [{}],
          toolDefinitions: [{ name: 'unrelated_tool' }],
          toolRegistry: new Map([['unrelated_tool', {}]]),
          toolContextMap: { unrelated_tool: 'Unrelated instructions.' },
          additional_instructions: 'Unrelated instructions.',
        } as never,
        createProviderRun: createProviderRun as never,
      });
      const result = executor({
        tool,
        messages: [],
        instructions: 'Existing memory instructions.',
        onResult,
      });
      if (outcome !== 'ok') await expect(result).rejects.toThrow('provider interrupted');
      else await result;
      expect(onResult).toHaveBeenCalledTimes(outcome === 'before' ? 0 : 1);
      expect(unregister).toHaveBeenCalledTimes(1);
      expect(active!.accepts({})).toBe(false);
    },
  );
});


describe('typed memory-tool completion without an authored chat answer', () => {
  it.each(['completed', 'no_tool', 'apply_failed', 'receipt_failed', 'other_failure', 'partial_result'])(
    'preserves exact completion and failure evidence: %s', async (outcome) => {
      const { tool, func, authorize, onResult } = fixture();
      let active: ReturnType<typeof createNativeMemoryToolBinding>;
      const unregister = jest.fn();
      if (outcome === 'apply_failed') func.mockRejectedValue(new Error('storage uncertain'));
      if (outcome === 'receipt_failed') onResult.mockRejectedValue(new Error('receipt unavailable'));
      if (outcome === 'partial_result') func.mockResolvedValue(['Partial', { memory: { type: 'error', value: '{"partialApplied":true}' } }]);
      const providerError = Object.assign(new Error('No authored response'), {
        code: outcome === 'other_failure' ? 'server_error' : 'missing_terminal_response',
      });
      const executor = createNativeMemoryExecutor({
        identity, authorize, user: { id: identity.userId } as never, requestBody: {},
        agent: { id: 'ephemeral', model_parameters: {} } as never,
        register: (binding) => { active = binding; return unregister; },
        buildBundle: async () => ({ glasshive_capability_broker: { synthetic: true } }),
        attachBundle: () => true,
        createProviderRun: (async () => ({ processStream: async () => {
          if (outcome !== 'no_tool') {
            try {
              await active.invoke({ user_id: identity.userId, message_id: identity.messageId,
                conversation_id: identity.conversationId, allowed_servers: [],
                allowed_host_tools: [tool.name], allow_dynamic_policy_servers: false,
                host_tool_resources: { [tool.name]: active.resource },
              }, operations);
            } catch { /* The provider still ends without an authored response. */ }
          }
          throw providerError;
        } })) as never,
      });
      const result = executor({ tool, messages: [], instructions: 'Memory task.', onResult });
      if (outcome === 'completed' || outcome === 'partial_result') await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toBe(providerError);
      expect(func).toHaveBeenCalledTimes(outcome === 'no_tool' ? 0 : 1);
      expect(onResult).toHaveBeenCalledTimes(['no_tool', 'apply_failed'].includes(outcome) ? 0 : 1);
      if (outcome === 'partial_result') expect(onResult.mock.calls[0][0][1].memory.type).toBe('error');
      expect(unregister).toHaveBeenCalledTimes(1);
    },
  );
});
