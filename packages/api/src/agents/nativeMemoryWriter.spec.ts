import { z } from 'zod';
import OpenAI from 'openai';
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
        prepareProviderAttempt: async () => async () => undefined,
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
      if (outcome === 'completed') func.mockResolvedValue(['No durable memory update needed', undefined]);
      if (outcome === 'apply_failed') func.mockRejectedValue(new Error('storage uncertain'));
      if (outcome === 'receipt_failed') onResult.mockRejectedValue(new Error('receipt unavailable'));
      if (outcome === 'partial_result') func.mockResolvedValue(['Partial', { memory: { type: 'error', value: '{"partialApplied":true}' } }]);
      const providerError = Object.assign(new Error('No authored response'), {
        code: outcome === 'other_failure'
          ? 'server_error'
          : ['completed', 'no_tool', 'receipt_failed'].includes(outcome)
            ? 'provider_response_failed'
            : 'missing_terminal_response',
      });
      const executor = createNativeMemoryExecutor({
        identity, authorize, user: { id: identity.userId } as never, requestBody: {},
        agent: { id: 'ephemeral', model_parameters: {} } as never,
        register: (binding) => { active = binding; return unregister; },
        buildBundle: async () => ({ glasshive_capability_broker: { synthetic: true } }),
        attachBundle: () => true,
        prepareProviderAttempt: async () => async () => undefined,
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
      if (outcome === 'completed') expect(onResult.mock.calls[0][0][1]).toBeUndefined();
      if (outcome === 'partial_result') expect(onResult.mock.calls[0][0][1].memory.type).toBe('error');
      expect(unregister).toHaveBeenCalledTimes(1);
    },
  );
});


describe('internal memory transport preserves the signed caller provenance', () => {
  it('sets the isolated system actor after bundle replacement without changing Main or its grant', async () => {
    const { tool, onResult, authorize } = fixture();
    let active: ReturnType<typeof createNativeMemoryToolBinding>;
    const unregister = jest.fn();
    const main = {
      id: 'main',
      provider: 'openai',
      endpoint: 'glasshive-harness',
      model: 'codex-cli:gpt-6.1-sol',
      tools: [],
      model_parameters: {
        model: 'codex-cli:gpt-6.1-sol',
        reasoning_effort: 'high',
        configuration: {
          baseURL: 'https://synthetic.invalid/v1',
          defaultHeaders: {
            'X-Viventium-Actor-Kind': 'external_user',
            'X-Viventium-Origin': 'interactive',
            'X-Viventium-Owner-Id': identity.userId,
          },
        },
      },
      agent_ids: ['worker'],
      edges: [{ from: 'main', to: 'worker' }],
      viventiumGraphLlmFallbacks: [{}],
      viventiumFallbackLlm: {},
      toolDefinitions: [{ name: 'unrelated_tool' }],
    };
    const mainBefore = JSON.stringify(main);
    const attachedHeaders = {
      'X-Viventium-Actor-Kind': 'external_user',
      'X-Viventium-Origin': 'interactive',
      'X-Viventium-Owner-Id': identity.userId,
      'X-GlassHive-Bootstrap-Bundle-B64': 'synthetic-signed-bundle',
      'X-GlassHive-Bootstrap-Timestamp': '123',
      'X-GlassHive-Bootstrap-Signature': 'synthetic-signature',
    };
    const createProviderRun = jest.fn(async (config) => {
      const native = config.agents[0];
      expect(native.model).toBe(main.model);
      expect(native.model_parameters.reasoning_effort).toBe('high');
      expect(native.model_parameters.configuration).toEqual({
        baseURL: 'https://synthetic.invalid/v1',
        defaultHeaders: { ...attachedHeaders, 'X-Viventium-Actor-Kind': 'system' },
        fetch: expect.any(Function),
      });
      expect(native.tools).toEqual([]);
      expect(native.toolDefinitions).toEqual([]);
      expect(native.agent_ids).toBeUndefined();
      expect(native.edges).toBeUndefined();
      expect(native.viventiumGraphLlmFallbacks).toBeUndefined();
      expect(native.viventiumFallbackLlm).toBeUndefined();
      expect(JSON.stringify(main)).toBe(mainBefore);
      expect(attachedHeaders['X-Viventium-Actor-Kind']).toBe('external_user');
      return { processStream: async () => {
        await active.invoke({
          user_id: identity.userId,
          message_id: identity.messageId,
          conversation_id: identity.conversationId,
          allowed_servers: [],
          allowed_host_tools: [tool.name],
          allow_dynamic_policy_servers: false,
          host_tool_resources: { [tool.name]: active.resource },
        }, operations);
      } };
    });
    const executor = createNativeMemoryExecutor({
      identity, authorize, user: { id: identity.userId } as never, requestBody: {},
      agent: main as never,
      register: (binding) => { active = binding; return unregister; },
      buildBundle: async (args) => {
        expect(args.allowedHostTools).toEqual([tool.name]);
        expect(args.allowedServerNames).toEqual([]);
        expect(args.hostToolResources[tool.name]).toEqual(active.resource);
        return { glasshive_capability_broker: { synthetic: true } };
      },
      attachBundle: ({ targetAgent, bundle }) => {
        expect(bundle.provider_capabilities?.native_tools).toBe(false);
        // Production attachment replaces all three objects after projecting the trusted caller.
        targetAgent.model_parameters = {
          ...targetAgent.model_parameters,
          configuration: {
            baseURL: 'https://synthetic.invalid/v1',
            defaultHeaders: attachedHeaders,
          },
        } as never;
        return true;
      },
      createProviderRun: createProviderRun as never,
      prepareProviderAttempt: async () => async () => undefined,
    });
    await expect(executor({
      tool, messages: [], instructions: 'Existing memory instructions.', onResult,
    })).resolves.toBeUndefined();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(main)).toBe(mainBefore);
  });
});

describe('native memory capacity and request lifecycle', () => {
  function transportFixture({
    responses,
    failAfterApply = false,
    releaseError,
    revokeAfterFirst = false,
    abortTransport = false,
    sdkRetries = false,
  }: {
    responses: Response[];
    failAfterApply?: boolean;
    releaseError?: Error;
    revokeAfterFirst?: boolean;
    abortTransport?: boolean;
    sdkRetries?: boolean;
  }) {
    const { tool, func, authorize, onResult } = fixture();
    let active: ReturnType<typeof createNativeMemoryToolBinding>;
    const unregister = jest.fn();
    const register = jest.fn((binding) => { active = binding; return unregister; });
    const transport = new AbortController();
    const send = jest.fn(async () => {
      const response = responses.shift()!;
      if (revokeAfterFirst) authorize.mockRejectedValue(new Error('writer owner changed'));
      if (abortTransport) transport.abort('writer stopped');
      return response;
    });
    const release = jest.fn(async () => {
      expect(unregister).not.toHaveBeenCalled();
      expect(active.accepts({})).toBe(false);
      if (releaseError) throw releaseError;
    });
    const prepareProviderAttempt = jest.fn(async (input) => {
      expect(input.requestBody.viventiumGlassHiveIdempotencyKey).toBe(active.identity
        ? `memory_${active.resource.bindingId}` : 'missing');
      expect(input.identity).toEqual(identity);
      return release;
    });
    const createProviderRun = jest.fn(async (config) => ({
      processStream: async () => {
        const native = config.agents[0];
        if (sdkRetries) {
          const sdk = new OpenAI({ apiKey: 'synthetic-key', baseURL: 'https://synthetic.invalid/v1',
            fetch: native.model_parameters.configuration.fetch });
          await sdk.chat.completions.create({ model: native.model,
            messages: [{ role: 'user', content: 'Synthetic memory source.' }] });
          throw new Error('expected capacity exhaustion');
        }
        const response = await native.model_parameters.configuration.fetch(
          'https://synthetic.invalid/v1/chat/completions',
          { method: 'POST', body: '{"synthetic":"same admitted request"}', signal: transport.signal },
        );
        if (!response.ok) throw Object.assign(new Error('capacity refused'), { code: 'host_capacity' });
        await active.invoke({
          user_id: identity.userId, message_id: identity.messageId,
          conversation_id: identity.conversationId, allowed_servers: [],
          allowed_host_tools: [tool.name], allow_dynamic_policy_servers: false,
          host_tool_resources: { [tool.name]: active.resource },
        }, operations);
        if (failAfterApply) throw Object.assign(new Error('provider interrupted'), { code: 'host_capacity' });
      },
    }));
    const executor = createNativeMemoryExecutor({
      identity, authorize, user: { id: identity.userId } as never, requestBody: {},
      agent: { id: 'writer', provider: 'openai', model: 'codex-cli:gpt-6.1-sol',
        model_parameters: { model: 'codex-cli:gpt-6.1-sol', reasoning_effort: 'high',
          configuration: { fetch: send } } } as never,
      register,
      buildBundle: async () => ({ glasshive_capability_broker: {} }),
      attachBundle: () => true,
      createProviderRun: createProviderRun as never,
      prepareProviderAttempt,
    });
    const result = executor({ tool, messages: [], instructions: 'Existing memory instructions.', onResult });
    return { result, send, release, register, createProviderRun, prepareProviderAttempt, unregister, func, onResult };
  }
  const capacity = (retryAfter = '0.001') => new Response(
    JSON.stringify({ error: { code: 'host_capacity' } }),
    { status: 503, headers: { 'Retry-After': retryAfter } },
  );

  it('recovers capacity on the same provider request, signed binding and snapshot', async () => {
    const f = transportFixture({ responses: [capacity(), new Response('{}')] });
    await expect(f.result).resolves.toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]);
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.createProviderRun).toHaveBeenCalledTimes(1);
    expect(f.prepareProviderAttempt).toHaveBeenCalledTimes(1);
    expect(f.func).toHaveBeenCalledTimes(1);
    expect(f.onResult).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });

  it.each(['exhausted', 'hard_failure', 'after_apply', 'owner_changed', 'aborted'])(
    'releases its exact failed native request before unregistering: %s', async (outcome) => {
      const f = transportFixture({
        responses: outcome === 'after_apply' ? [new Response('{}')] :
          outcome === 'hard_failure' ? [new Response('{}', { status: 503 })] :
            [capacity(outcome === 'exhausted' ? '31' : '0.001')],
        failAfterApply: outcome === 'after_apply',
        revokeAfterFirst: outcome === 'owner_changed',
        abortTransport: outcome === 'aborted',
      });
      await expect(f.result).rejects.toThrow();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.createProviderRun).toHaveBeenCalledTimes(1);
      expect(f.func).toHaveBeenCalledTimes(outcome === 'after_apply' ? 1 : 0);
      expect(f.onResult).toHaveBeenCalledTimes(outcome === 'after_apply' ? 1 : 0);
      expect(f.unregister).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the original provider error when native release cannot be confirmed', async () => {
    const f = transportFixture({ responses: [capacity('31')], releaseError: new Error('ACK unavailable') });
    await expect(f.result).rejects.toMatchObject({ code: 'host_capacity', nativeMemoryReleaseConfirmed: false });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.unregister).toHaveBeenCalledTimes(1);
    expect(f.func).not.toHaveBeenCalled();
  });

  it('releases after the existing SDK retry policy exhausts the same capacity-blocked request', async () => {
    const refusal = () => new Response(JSON.stringify({ error: { code: 'host_capacity',
      message: 'Synthetic capacity refusal' } }), { status: 503,
      headers: { 'Retry-After': '31', 'retry-after-ms': '1' } });
    const f = transportFixture({ responses: [refusal(), refusal(), refusal()], sdkRetries: true });
    await expect(f.result).rejects.toMatchObject({ code: 'host_capacity' });
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.createProviderRun).toHaveBeenCalledTimes(1);
    expect(f.func).not.toHaveBeenCalled();
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });
});
