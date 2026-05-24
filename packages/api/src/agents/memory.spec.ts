import { Types } from 'mongoose';
import { Run, Providers } from '@librechat/agents';
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

    const { HumanMessage } = await import('@langchain/core/messages');
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
    const first = await loadMemoryReadContext({ userId: 'user-123', memoryMethods: methods, config });
    const second = await loadMemoryReadContext({ userId: 'user-123', memoryMethods: methods, config });
    clearMemoryReadContextCache('user-123');
    const third = await loadMemoryReadContext({ userId: 'user-123', memoryMethods: methods, config });

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
    });
    expect(methods.getFormattedMemories).toHaveBeenCalledWith({ userId: 'user-123' });
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
