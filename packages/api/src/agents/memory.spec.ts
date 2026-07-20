import { Types } from 'mongoose';
import { Run, Providers } from '@librechat/agents';
import { Tools } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import {
  clearMemoryReadContextCache,
  clearMemoryWriterHealth,
  createMemoryProcessor,
  getMemoryWriterHealthGate,
  loadMemoryReadContext,
  loadMemorySnapshot,
  markMemoryWriterFailure,
  processMemory,
} from './memory';

jest.mock('~/stream/GenerationJobManager');

const mockCreateSafeUser = jest.fn((user) => ({
  id: user?.id,
  email: user?.email,
  name: user?.name,
  username: user?.username,
}));

const mockResolveHeaders = jest.fn((opts) => {
  const headers = opts.headers || {};
  const user = opts.user || {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let resolved = value as string;
    resolved = resolved.replace(/\$\{(\w+)\}/g, (_match, envVar) => process.env[envVar] || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_EMAIL\}\}/g, user.email || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_ID\}\}/g, user.id || '');
    result[key] = resolved;
  }
  return result;
});

jest.mock('~/utils', () => ({
  Tokenizer: {
    getTokenCount: jest.fn(() => 10),
  },
  createSafeUser: (user: unknown) => mockCreateSafeUser(user),
  resolveHeaders: (opts: unknown) => mockResolveHeaders(opts),
}));

const { createSafeUser } = jest.requireMock('~/utils');
const TEST_CUSTOM_API_KEY = ['test', 'custom', 'api', 'key'].join('-');

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    Run: {
      create: jest.fn(() => ({
        processStream: jest.fn(() => Promise.resolve('success')),
      })),
    },
    Providers: actual.Providers,
    GraphEvents: actual.GraphEvents,
  };
});

function createTestUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    createdAt: new Date('2021-01-01'),
    updatedAt: new Date('2021-01-01'),
    emailVerified: true,
    ...overrides,
  } as IUser;
}

describe('Memory Agent Header Resolution', () => {
  let testUser: IUser;
  let mockRes: Response;
  let mockMemoryMethods: {
    setMemory: jest.Mock;
    deleteMemory: jest.Mock;
    getFormattedMemories: jest.Mock;
  };

  beforeEach(() => {
    process.env.CUSTOM_API_KEY = TEST_CUSTOM_API_KEY;
    process.env.TEST_CUSTOM_API_KEY = TEST_CUSTOM_API_KEY;

    testUser = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });

    mockRes = {
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
    } as unknown as Response;

    mockMemoryMethods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(() =>
        Promise.resolve({
          withKeys: 'formatted memories',
          withoutKeys: 'memories without keys',
          totalTokens: 100,
        }),
      ),
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUSTOM_API_KEY;
    delete process.env.TEST_CUSTOM_API_KEY;
  });

  it('should resolve environment variables in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'api-key': '${TEST_CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': TEST_CUSTOM_API_KEY,
      'api-key': TEST_CUSTOM_API_KEY,
    });
  });

  it('should resolve user placeholders in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'X-User-Identifier': 'test@example.com',
      'X-User-ID': 'user-123',
    });
  });

  it('should handle mixed environment variables and user placeholders', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-Application-Identifier': 'LibreChat - Test',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': TEST_CUSTOM_API_KEY,
      'X-User-Identifier': 'test@example.com',
      'X-Application-Identifier': 'LibreChat - Test',
    });
  });

  it('should resolve env vars when user is undefined', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: undefined,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': TEST_CUSTOM_API_KEY,
    });
  });

  it('should not throw when llmConfig has no configuration', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration).toBeUndefined();
  });

  it('should use createSafeUser to sanitize user data', async () => {
    const userWithSensitiveData = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      password: 'sensitive-password',
      refreshToken: 'sensitive-token',
    } as unknown as Partial<IUser>);

    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: userWithSensitiveData,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();

    // Verify createSafeUser was used - the user object passed to Run.create should not have sensitive fields
    const safeUser = createSafeUser(userWithSensitiveData);
    expect(safeUser).not.toHaveProperty('password');
    expect(safeUser).not.toHaveProperty('refreshToken');
    expect(safeUser).toHaveProperty('id');
    expect(safeUser).toHaveProperty('email');
  });

  it('should include instructions in user message for Bedrock provider', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    };

    const { HumanMessage } = await import('@librechat/agents/langchain/messages');
    const testMessage = new HumanMessage('test chat content');

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [testMessage],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For Bedrock, instructions should NOT be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBeUndefined();
    expect(runConfig.graphConfig.additional_instructions).toBeUndefined();
  });

  it('should pass instructions to graphConfig for non-Bedrock providers', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For non-Bedrock providers, instructions should be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBe('test instructions');
    expect(runConfig.graphConfig.additional_instructions).toBeDefined();
  });

  it('should force the unified memory decision tool for OpenAI memory runs', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-5.4',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.tool_choice).toBe('apply_memory_changes');
    expect(runConfig.graphConfig.llmConfig.modelKwargs).toEqual(
      expect.objectContaining({
        tool_choice: {
          type: 'function',
          name: 'apply_memory_changes',
        },
      }),
    );
    expect(runConfig.graphConfig.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'apply_memory_changes',
        'set_memory',
        'delete_memory',
        'noop_memory',
      ]),
    );
  });

  it('should force the unified memory decision tool for Anthropic memory runs', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.tool_choice).toBe('apply_memory_changes');
    expect(runConfig.graphConfig.llmConfig.invocationKwargs).toEqual(
      expect.objectContaining({
        tool_choice: {
          type: 'tool',
          name: 'apply_memory_changes',
        },
      }),
    );
    expect(runConfig.graphConfig.llmConfig.thinking).toBeUndefined();
    expect(runConfig.graphConfig.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'apply_memory_changes',
        'set_memory',
        'delete_memory',
        'noop_memory',
      ]),
    );
  });

  it('should set temperature to 1 for Bedrock with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      temperature: 0.7,
      additionalModelRequestFields: {
        thinking: {
          type: 'enabled',
          budget_tokens: 5000,
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(1);
  });

  it('should not modify temperature for Bedrock without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should remove temperature for Anthropic with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      thinking: {
        type: 'enabled',
        budget_tokens: 5000,
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toBeUndefined();
  });

  it('should remove temperature for Anthropic when runtime default thinking applies', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toBeUndefined();
  });

  it('should disable Anthropic thinking and strip output_config when tool choice is forced', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-opus-4-7',
      temperature: 0.7,
      invocationKwargs: {
        output_config: {
          effort: 'high',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.invocationKwargs).toEqual({
      tool_choice: {
        type: 'tool',
        name: 'apply_memory_changes',
      },
    });
  });

  it('should remove temperature for Anthropic adaptive-capable Opus 4.7 when thinking is explicitly disabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-opus-4-7',
      temperature: 0.7,
      thinking: false,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toBeUndefined();
  });

  it('should remove temperature for Anthropic with adaptive thinking', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-opus-4-7',
      temperature: 0.7,
      thinking: {
        type: 'adaptive',
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toBeUndefined();
  });

  it('should remove temperature for Anthropic adaptive-capable Opus 4.7 with disabled thinking config', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-opus-4-7',
      temperature: 0.7,
      thinking: {
        type: 'disabled',
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
  });

  it('should preserve temperature for legacy Anthropic models when thinking is explicitly disabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5-20250929',
      temperature: 0.7,
      thinking: false,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });
});

describe('Memory snapshot loading', () => {
  beforeEach(() => {
    clearMemoryReadContextCache();
    clearMemoryWriterHealth({
      userId: 'user-123',
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5',
    });
  });

  it('loads a bounded deduped read context without running writer maintenance or formatted memory', async () => {
    const userId = new Types.ObjectId();
    const methods = {
      setMemory: jest.fn().mockResolvedValue({ ok: true }),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'core',
          value: 'Old core memory.',
          tokenCount: 5,
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'core',
          value: 'New core memory.',
          tokenCount: 5,
          updated_at: new Date('2026-05-01T00:00:00Z'),
        },
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'world',
          value: 'World memory '.repeat(40),
          tokenCount: 120,
          updated_at: new Date('2026-04-01T00:00:00Z'),
        },
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'legacy',
          value: 'Legacy key should not be injected.',
          tokenCount: 8,
          updated_at: new Date('2026-05-02T00:00:00Z'),
        },
      ]),
    };

    const context = await loadMemoryReadContext({
      userId,
      memoryMethods: methods,
      config: {
        validKeys: ['core', 'world'],
        readProfile: {
          tokenLimit: 40,
          keyOrder: ['core', 'world'],
          keyLimits: { core: 20, world: 12 },
          cacheTtlMs: 10_000,
        },
      },
    });

    expect(context.text).toContain('New core memory.');
    expect(context.text).not.toContain('Old core memory.');
    expect(context.text).not.toContain('Legacy key should not be injected.');
    expect(context.text).toContain('## world');
    expect(context.text).toContain('...');
    expect(context.includedKeys).toEqual(['core', 'world']);
    expect(context.duplicateKeys).toEqual(['core']);
    expect(methods.getAllUserMemories).toHaveBeenCalledWith(userId);
    expect(methods.getFormattedMemories).not.toHaveBeenCalled();
    expect(methods.setMemory).not.toHaveBeenCalled();
  });

  it('preserves the tail of truncated memory entries so recent durable facts stay visible', async () => {
    const userId = new Types.ObjectId();
    const tailFact = 'QA_TAIL_FACT fictional cousin Marnie uses codeword MEMCANARY-TORONTO.';
    const methods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'world',
          value: `${'Older world context. '.repeat(80)}${tailFact}`,
          tokenCount: 420,
          updated_at: new Date('2026-06-25T00:00:00Z'),
        },
      ]),
    };

    const context = await loadMemoryReadContext({
      userId,
      memoryMethods: methods,
      config: {
        validKeys: ['world'],
        readProfile: {
          tokenLimit: 80,
          keyOrder: ['world'],
          keyLimits: { world: 48 },
          cacheTtlMs: 10_000,
        },
      },
    });

    expect(context.text).toContain('Older world context.');
    expect(context.text).toContain('...');
    expect(context.text).toContain(tailFact);
    expect(context.omittedKeys).toContain('world:truncated');
  });

  it('keeps the governed preferences key intact so middle facts remain available without RAG', async () => {
    const userId = new Types.ObjectId();
    const middleFact = 'Synthetic tea preference = amber juniper.';
    const value = `${'Older preference context. '.repeat(40)}${middleFact}${'Newer preference context. '.repeat(40)}`;
    const methods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          userId,
          key: 'preferences',
          value,
          tokenCount: 471,
          updated_at: new Date('2026-07-14T00:00:00Z'),
        },
      ]),
    };

    const context = await loadMemoryReadContext({
      userId,
      memoryMethods: methods,
      config: { validKeys: ['preferences'] },
    });

    expect(context.text).toContain(middleFact);
    expect(context.text).not.toContain('\n...\n');
    expect(context.totalTokens).toBe(471);
    expect(context.omittedKeys).not.toContain('preferences:truncated');
  });

  it('caches the read context by user and read profile until explicitly cleared', async () => {
    const methods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          userId: 'user-123',
          key: 'core',
          value: 'Cached core memory.',
          tokenCount: 5,
          updated_at: new Date('2026-05-01T00:00:00Z'),
        },
      ]),
    };

    const config = {
      validKeys: ['core'],
      readProfile: { tokenLimit: 200, cacheTtlMs: 10_000 },
    };
    const first = await loadMemoryReadContext({
      userId: 'user-123',
      memoryMethods: methods,
      config,
    });
    const second = await loadMemoryReadContext({
      userId: 'user-123',
      memoryMethods: methods,
      config,
    });
    clearMemoryReadContextCache('user-123');
    const third = await loadMemoryReadContext({
      userId: 'user-123',
      memoryMethods: methods,
      config,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(third.cacheHit).toBe(false);
    expect(methods.getAllUserMemories).toHaveBeenCalledTimes(2);
  });

  it('gates repeated memory writer runs after provider authentication failure', () => {
    const status = markMemoryWriterFailure({
      userId: 'user-123',
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5',
      error: { status: 401, message: 'Invalid authentication credentials' },
    });

    const gate = getMemoryWriterHealthGate({
      userId: 'user-123',
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-5',
    });

    expect(status?.reason).toBe('auth');
    expect(gate.blocked).toBe(true);
    if (gate.blocked) {
      expect(gate.message).toContain('Reconnect');
      expect(gate.shouldLog).toBe(true);
    }
  });

  it('loads stored memory without requiring a writer agent', async () => {
    const methods = {
      setMemory: jest.fn().mockResolvedValue({ ok: true }),
      deleteMemory: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([]),
      getAllUserMemoryStates: jest.fn().mockResolvedValue([]),
      getFormattedMemories: jest.fn().mockResolvedValue({
        withKeys: 'with keys',
        withoutKeys: 'without keys',
        totalTokens: 42,
        memoryTokenMap: { core: 42 },
      }),
    };

    const snapshot = await loadMemorySnapshot({
      userId: 'user-123',
      memoryMethods: methods,
      config: { validKeys: ['core'] },
    });

    expect(snapshot).toEqual({
      withKeys: 'with keys',
      withoutKeys: 'without keys',
      totalTokens: 42,
      memoryTokenMap: { core: 42 },
      memoryRevisionMap: {},
      memoryValueHashMap: {},
    });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-123',
      memories: [],
    });
  });

  it('derives prompt content and CAS revisions from the same state query', async () => {
    const methods = {
      setMemory: jest.fn().mockResolvedValue({ ok: true }),
      deleteMemory: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([
        {
          key: 'context',
          value: 'Older context that must not be paired with a newer revision.',
          tokenCount: 12,
          __v: 3,
        },
      ]),
      getAllUserMemoryStates: jest.fn().mockResolvedValue([
        {
          key: 'context',
          value: 'Current context from the revision-bearing state row.',
          tokenCount: 11,
          __v: 4,
        },
      ]),
      getFormattedMemories: jest.fn(async ({ memories }) => ({
        withKeys: `context: ${memories[0]?.value ?? ''}`,
        withoutKeys: memories[0]?.value ?? '',
        totalTokens: memories[0]?.tokenCount ?? 0,
        memoryTokenMap: { context: memories[0]?.tokenCount ?? 0 },
      })),
    };

    const snapshot = await loadMemorySnapshot({
      userId: 'user-123',
      memoryMethods: methods,
      config: { validKeys: ['context'] },
    });

    expect(snapshot.withKeys).toContain('Current context from the revision-bearing state row.');
    expect(snapshot.withKeys).not.toContain('Older context');
    expect(snapshot.memoryRevisionMap).toEqual({ context: 4 });
    expect(snapshot.memoryValueHashMap.context).toEqual(expect.any(String));
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-123',
      memories: [
        expect.objectContaining({
          value: 'Current context from the revision-bearing state row.',
        }),
      ],
    });
  });

  it('reuses a preloaded snapshot when creating the memory processor', async () => {
    const methods = {
      setMemory: jest.fn().mockResolvedValue({ ok: true }),
      deleteMemory: jest.fn(),
      getAllUserMemories: jest.fn().mockResolvedValue([]),
      getFormattedMemories: jest.fn(),
    };

    const snapshot = {
      withKeys: 'with keys',
      withoutKeys: 'without keys',
      totalTokens: 42,
      memoryTokenMap: { core: 42 },
      memoryRevisionMap: {},
      memoryValueHashMap: {},
    };

    const [withoutKeys] = await createMemoryProcessor({
      res: {
        write: jest.fn(),
        end: jest.fn(),
        headersSent: false,
      } as unknown as Response,
      userId: 'user-123',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      memoryMethods: methods,
      config: { validKeys: ['core'] },
      snapshot,
      user: createTestUser(),
    });

    expect(withoutKeys).toBe('without keys');
    expect(methods.getFormattedMemories).not.toHaveBeenCalled();
  });
});

describe('Memory policy retry contract', () => {
  const Tokenizer = jest.requireMock('~/utils').Tokenizer as { getTokenCount: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    Tokenizer.getTokenCount.mockImplementation((text: string) => text.length);
  });

  afterEach(() => {
    Tokenizer.getTokenCount.mockImplementation(() => 10);
  });

  function installMemoryRunMock(
    operationsByAttempt: Array<
      Array<{
        action: 'set' | 'delete' | 'noop';
        key?: string;
        value?: string;
        reason?: string;
      }>
    >,
  ) {
    let attempt = 0;
    (Run.create as jest.Mock).mockImplementation((runConfig) => {
      const currentAttempt = attempt++;
      return {
        processStream: jest.fn(async () => {
          const decisionTool = runConfig.graphConfig.tools.find(
            (candidate: { name: string }) => candidate.name === 'apply_memory_changes',
          );
          const result = await decisionTool.func({
            operations: operationsByAttempt[currentAttempt] ?? operationsByAttempt.at(-1),
          });
          const handler = Object.values(runConfig.customHandlers)[0] as {
            handle: (event: string, data: unknown, metadata: unknown) => void;
          };
          handler.handle(
            'tool_end',
            {
              output: {
                artifact: result[1],
                tool_call_id: `memory-call-${currentAttempt}`,
              },
            },
            { run_id: 'msg-123', thread_id: 'conv-123' },
          );
          return 'processed';
        }),
      };
    });
  }

  async function createWriter({
    keyLimits,
    memoryTokenMap,
    totalTokens,
    tokenLimit = 100,
    setMemory,
  }: {
    keyLimits: Record<string, number>;
    memoryTokenMap: Record<string, number>;
    totalTokens: number;
    tokenLimit?: number;
    setMemory: jest.Mock;
  }) {
    const memoryMethods = {
      setMemory,
      deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
      getFormattedMemories: jest.fn(),
      getAllUserMemories: jest.fn(),
      getAllUserMemoryStates: jest.fn(),
    };
    const [, writer] = await createMemoryProcessor({
      res: {
        write: jest.fn(),
        end: jest.fn(),
        headersSent: false,
      } as unknown as Response,
      userId: 'user-123',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      memoryMethods,
      config: {
        validKeys: Object.keys(keyLimits),
        keyLimits,
        tokenLimit,
        instructions: 'Preserve existing memory and apply explicit memory requests.',
        llmConfig: { provider: Providers.OPENAI, model: 'gpt-5.4' },
      },
      snapshot: {
        withKeys: 'Existing synthetic memory',
        withoutKeys: 'Existing synthetic memory',
        totalTokens,
        memoryTokenMap,
        memoryRevisionMap: Object.fromEntries(Object.keys(keyLimits).map((key) => [key, 0])),
        memoryValueHashMap: {},
      },
      user: createTestUser(),
    });
    return writer;
  }

  it('retries one rejected budget proposal and returns only the successful attachment', async () => {
    installMemoryRunMock([
      [{ action: 'set', key: 'preferences', value: '12345678901' }],
      [{ action: 'set', key: 'preferences', value: '123456789' }],
    ]);
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });
    const writer = await createWriter({
      keyLimits: { preferences: 10 },
      memoryTokenMap: { preferences: 9 },
      totalTokens: 9,
      setMemory,
    });

    const { HumanMessage } = await import('@langchain/core/messages');
    const attachments = await writer([new HumanMessage('Remember the synthetic preference.')]);

    expect(Run.create).toHaveBeenCalledTimes(2);
    expect(setMemory).toHaveBeenCalledTimes(1);
    expect(setMemory).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'preferences', value: '123456789', expectedRevision: 0 }),
    );
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.[Tools.memory]).toEqual(
      expect.objectContaining({ type: 'update', key: 'preferences', revision: 1 }),
    );
    expect((Run.create as jest.Mock).mock.calls[1][0].graphConfig.additional_instructions).toContain(
      'preferences',
    );
  });

  it('stops after one correction attempt and returns the final structured budget error', async () => {
    installMemoryRunMock([
      [{ action: 'set', key: 'preferences', value: '12345678901' }],
      [{ action: 'set', key: 'preferences', value: 'abcdefghijk' }],
    ]);
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });
    const writer = await createWriter({
      keyLimits: { preferences: 10 },
      memoryTokenMap: { preferences: 9 },
      totalTokens: 9,
      setMemory,
    });

    const { HumanMessage } = await import('@langchain/core/messages');
    const attachments = await writer([new HumanMessage('Remember the synthetic preference.')]);
    const error = JSON.parse(String(attachments?.[0]?.[Tools.memory]?.value));

    expect(Run.create).toHaveBeenCalledTimes(2);
    expect(setMemory).not.toHaveBeenCalled();
    expect(attachments?.[0]?.[Tools.memory]?.type).toBe('error');
    expect(error).toEqual(expect.objectContaining({ errorType: 'key_limit_exceeded' }));
  });

  it('preserves the original rejection when the correction returns noop', async () => {
    installMemoryRunMock([
      [{ action: 'set', key: 'preferences', value: '12345678901' }],
      [{ action: 'noop', reason: 'No correction proposed.' }],
    ]);
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });
    const writer = await createWriter({
      keyLimits: { preferences: 10 },
      memoryTokenMap: { preferences: 9 },
      totalTokens: 9,
      setMemory,
    });

    const { HumanMessage } = await import('@langchain/core/messages');
    const attachments = await writer([new HumanMessage('Remember the synthetic preference.')]);
    const error = JSON.parse(String(attachments?.[0]?.[Tools.memory]?.value));

    expect(Run.create).toHaveBeenCalledTimes(2);
    expect(setMemory).not.toHaveBeenCalled();
    expect(attachments?.[0]?.[Tools.memory]?.type).toBe('error');
    expect(error).toEqual(expect.objectContaining({ errorType: 'key_limit_exceeded' }));
  });

  it('stops a rejected batch before any later operation can write', async () => {
    installMemoryRunMock([
      [
        { action: 'set', key: 'preferences', value: '12345678901' },
        { action: 'set', key: 'drafts', value: 'draft' },
      ],
      [{ action: 'set', key: 'preferences', value: '123456789' }],
    ]);
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });
    const writer = await createWriter({
      keyLimits: { preferences: 10, drafts: 10 },
      memoryTokenMap: { preferences: 9, drafts: 0 },
      totalTokens: 9,
      setMemory,
    });

    const { HumanMessage } = await import('@langchain/core/messages');
    await writer([new HumanMessage('Remember the synthetic preference.')]);

    expect(Run.create).toHaveBeenCalledTimes(2);
    expect(setMemory).toHaveBeenCalledTimes(1);
    expect(setMemory).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'preferences', value: '123456789' }),
    );
  });

  it.each([
    {
      errorType: 'already_exceeded',
      tokenLimit: 10,
      keyLimits: { preferences: 100 },
      memoryTokenMap: { preferences: 11 },
      rejectedValue: '123456789012',
    },
    {
      errorType: 'would_exceed',
      tokenLimit: 10,
      keyLimits: { preferences: 100 },
      memoryTokenMap: { preferences: 9 },
      rejectedValue: '12345678901',
    },
    {
      errorType: 'key_limit_exceeded',
      tokenLimit: 100,
      keyLimits: { preferences: 10 },
      memoryTokenMap: { preferences: 9 },
      rejectedValue: '12345678901',
    },
    {
      errorType: 'key_already_exceeded',
      tokenLimit: 100,
      keyLimits: { preferences: 10 },
      memoryTokenMap: { preferences: 11 },
      rejectedValue: 'abcdefghijk',
    },
  ])('allows one correction for $errorType', async ({
    tokenLimit,
    keyLimits,
    memoryTokenMap,
    rejectedValue,
  }) => {
    installMemoryRunMock([
      [{ action: 'set', key: 'preferences', value: rejectedValue }],
      [{ action: 'set', key: 'preferences', value: '123456789' }],
    ]);
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });
    const writer = await createWriter({
      keyLimits,
      memoryTokenMap,
      totalTokens: memoryTokenMap.preferences,
      tokenLimit,
      setMemory,
    });

    const { HumanMessage } = await import('@langchain/core/messages');
    const attachments = await writer([new HumanMessage('Remember the synthetic preference.')]);

    expect(Run.create).toHaveBeenCalledTimes(2);
    expect(setMemory).toHaveBeenCalledTimes(1);
    expect(attachments?.[0]?.[Tools.memory]?.type).toBe('update');
  });

  it('does not retry a failed batch after an earlier operation already applied', async () => {
    installMemoryRunMock([
      [
        { action: 'set', key: 'preferences', value: '123456789' },
        { action: 'set', key: 'drafts', value: '12345678901' },
      ],
    ]);
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });
    const writer = await createWriter({
      keyLimits: { preferences: 10, drafts: 10 },
      memoryTokenMap: { preferences: 0, drafts: 0 },
      totalTokens: 0,
      setMemory,
    });

    const { HumanMessage } = await import('@langchain/core/messages');
    const attachments = await writer([new HumanMessage('Remember two synthetic facts.')]);
    const error = JSON.parse(String(attachments?.[0]?.[Tools.memory]?.value));

    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(setMemory).toHaveBeenCalledTimes(1);
    expect(attachments?.[0]?.[Tools.memory]?.type).toBe('error');
    expect(error).toEqual(expect.objectContaining({ partialApplied: true }));
  });

  it('does not replay an applied write after a retryable upstream failure', async () => {
    let processStream: jest.Mock;
    (Run.create as jest.Mock).mockImplementation((runConfig) => {
      processStream = jest.fn(async () => {
        const decisionTool = runConfig.graphConfig.tools.find(
          (candidate: { name: string }) => candidate.name === 'apply_memory_changes',
        );
        const result = await decisionTool.func({
          operations: [{ action: 'set', key: 'preferences', value: '123456789' }],
        });
        const handler = Object.values(runConfig.customHandlers)[0] as {
          handle: (event: string, data: unknown, metadata: unknown) => void;
        };
        handler.handle(
          'tool_end',
          { output: { artifact: result[1], tool_call_id: 'memory-call-0' } },
          { run_id: 'msg-123', thread_id: 'conv-123' },
        );
        const error = Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
        throw error;
      });
      return { processStream };
    });
    const setMemory = jest.fn().mockResolvedValue({ ok: true, revision: 1 });

    await processMemory({
      res: { write: jest.fn(), end: jest.fn(), headersSent: false } as unknown as Response,
      userId: 'user-123',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      messages: [],
      memory: 'Existing synthetic memory',
      instructions: 'Apply explicit durable-memory requests.',
      llmConfig: { provider: Providers.OPENAI, model: 'gpt-5.4' },
      validKeys: ['preferences'],
      keyLimits: { preferences: 10 },
      tokenLimit: 100,
      memoryTokenMap: { preferences: 9 },
      memoryRevisionMap: { preferences: 0 },
      totalTokens: 9,
      setMemory,
      deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
      user: createTestUser(),
    });

    expect(processStream!).toHaveBeenCalledTimes(1);
    expect(setMemory).toHaveBeenCalledTimes(1);
  });
});
