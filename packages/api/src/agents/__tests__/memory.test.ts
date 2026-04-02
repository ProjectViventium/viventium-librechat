import { Response } from 'express';
import { Providers } from '@librechat/agents';
import { Tools } from 'librechat-data-provider';
import type { MemoryArtifact } from 'librechat-data-provider';
import { createMemoryTool, processMemory } from '../memory';

// Mock the logger
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  format: {
    combine: jest.fn(),
    colorize: jest.fn(),
    simple: jest.fn(),
  },
  transports: {
    Console: jest.fn(),
  },
}));

// Mock the Tokenizer
jest.mock('~/utils', () => ({
  Tokenizer: {
    getTokenCount: jest.fn((text: string) => text.length), // Simple mock: 1 char = 1 token
  },
}));

// Mock the Run module
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  Run: {
    create: jest.fn(),
  },
  Providers: {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    AZURE: 'azure',
  },
  GraphEvents: {
    TOOL_END: 'tool_end',
  },
}));

describe('createMemoryTool', () => {
  let mockSetMemory: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMemory = jest.fn().mockResolvedValue({ ok: true });
  });

  describe('overflow handling', () => {
    it('should return error artifact when memory is already overflowing', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 150, // Already over limit
      });

      // Call the underlying function directly since invoke() doesn't handle responseFormat in tests
      const result = await tool.func({ key: 'test', value: 'new memory' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory storage exceeded. Reduce existing memory before adding more.');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(artifacts[Tools.memory].key).toBe('system');

      const errorData = JSON.parse(artifacts[Tools.memory].value as string);
      expect(errorData).toEqual(
        expect.objectContaining({
          errorType: 'already_exceeded',
          totalTokens: 150,
          tokenLimit: 100,
          projectedTotalTokens: 160,
        }),
      );

      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should return error artifact when new memory would exceed limit', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 80,
      });

      // This would put us at 101 tokens total, exceeding the limit
      const result = await tool.func({ key: 'test', value: 'This is a 20 char str' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory storage would exceed the configured token limit.');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(artifacts[Tools.memory].key).toBe('system');

      const errorData = JSON.parse(artifacts[Tools.memory].value as string);
      expect(errorData).toEqual(
        expect.objectContaining({
          errorType: 'would_exceed',
          totalTokens: 80,
          tokenLimit: 100,
          projectedTotalTokens: 101,
          tokenDelta: 21,
        }),
      );

      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should successfully save memory when below limit', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 50,
      });

      const result = await tool.func({ key: 'test', value: 'small memory' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory set for key "test" (12 tokens)');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('update');
      expect(artifacts[Tools.memory].key).toBe('test');
      expect(artifacts[Tools.memory].value).toBe('small memory');

      expect(mockSetMemory).toHaveBeenCalledWith({
        userId: 'test-user',
        key: 'test',
        value: 'small memory',
        tokenCount: 12,
      });
    });

    it('should include the backend error message for per-key budget violations', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        keyLimits: { drafts: 10 },
        memoryTokenMap: { drafts: 9 },
        totalTokens: 9,
      });

      const result = await tool.func({ key: 'drafts', value: 'this update is longer' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory key "drafts" would exceed its 10-token budget.');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      const errorData = JSON.parse(artifacts[Tools.memory].value as string);
      expect(errorData).toEqual(
        expect.objectContaining({
          errorType: 'key_limit_exceeded',
          key: 'drafts',
          keyLimit: 10,
          message: 'Memory key "drafts" would exceed its 10-token budget.',
        }),
      );

      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('compacts world writes before returning a per-key budget error', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        keyLimits: { world: 220 },
        memoryTokenMap: { world: 190 },
        totalTokens: 190,
      });

      const worldValue = [
        'Partner: Sam. Met May 25 2022. Recently requested a birthday gift.',
        'Ventures:',
        '- Project Atlas: Decision intelligence for regulated enterprises. prod live. pending DNS/Gemini. Robin call Thu 3PM ET.',
        'Key people: Morgan (co-founder), Taylor (outreach stalled)',
      ].join('\n');

      const result = await tool.func({ key: 'world', value: worldValue });
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('Memory set for key "world"');

      expect(mockSetMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user',
          key: 'world',
        }),
      );
      const savedValue = mockSetMemory.mock.calls[0][0].value;
      expect(savedValue).toContain('Met May 25 2022');
      expect(savedValue).not.toContain('birthday gift');
      expect(savedValue).not.toContain('pending DNS');
      expect(savedValue).not.toContain('@');
    });
  });

  /* === VIVENTIUM START ===
   * Fix: Tests for overwrite-aware tokenLimit enforcement (delta-based).
   * Added: 2026-02-09
   * === VIVENTIUM END === */
  describe('overwrite delta handling', () => {
    it('should allow overwriting a key with fewer tokens (net-negative delta)', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 90,
        memoryTokenMap: { context: 50, working: 40 },
      });

      const smaller = 'x'.repeat(40); // delta = 40 - 50 = -10
      const result = await tool.func({ key: 'context', value: smaller });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory set for key "context" (40 tokens)');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('update');
      expect(artifacts[Tools.memory].key).toBe('context');

      expect(mockSetMemory).toHaveBeenCalledWith({
        userId: 'test-user',
        key: 'context',
        value: smaller,
        tokenCount: 40,
      });
    });

    it('should block overwriting a key only when the net delta would exceed the limit', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 90,
        memoryTokenMap: { context: 50, working: 40 },
      });

      const bigger = 'x'.repeat(65); // delta = 65 - 50 = +15 => projected total 105
      const result = await tool.func({ key: 'context', value: bigger });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory storage would exceed the configured token limit.');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(artifacts[Tools.memory].key).toBe('system');

      const errorData = JSON.parse(artifacts[Tools.memory].value as string);
      expect(errorData).toEqual(
        expect.objectContaining({
          errorType: 'would_exceed',
          totalTokens: 90,
          tokenLimit: 100,
          projectedTotalTokens: 105,
          tokenDelta: 15,
        }),
      );

      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should track running total across consecutive overwrites in the same run', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 90,
        memoryTokenMap: { context: 50, working: 40 },
      });

      const result1 = await tool.func({ key: 'context', value: 'x'.repeat(40) }); // total 80
      expect(result1[0]).toBe('Memory set for key "context" (40 tokens)');

      const result2 = await tool.func({ key: 'working', value: 'x'.repeat(60) }); // total 100
      expect(result2[0]).toBe('Memory set for key "working" (60 tokens)');

      expect(mockSetMemory).toHaveBeenCalledTimes(2);
    });

    it('should allow self-healing overwrites when already over limit (delta <= 0)', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 110, // Already over limit
        memoryTokenMap: { context: 60, working: 50 },
      });

      const smaller = 'x'.repeat(30); // delta = 30 - 60 = -30
      const result = await tool.func({ key: 'context', value: smaller });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory set for key "context" (30 tokens)');

      expect(mockSetMemory).toHaveBeenCalledWith({
        userId: 'test-user',
        key: 'context',
        value: smaller,
        tokenCount: 30,
      });
    });
  });

  describe('basic functionality', () => {
    it('should reject operational residue instead of storing it', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
      });

      const result = await tool.func({
        key: 'me',
        value: 'Wake loop {NTA} with tool auth errors and schedule_list user_id missing',
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(
        'Memory value contains scheduler or tool operational residue. Store the durable user fact or project state instead.',
      );

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should reject writes that exceed a per-key budget', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        keyLimits: { drafts: 10 },
      });

      const result = await tool.func({
        key: 'drafts',
        value: '01234567890',
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory key "drafts" would exceed its 10-token budget.');
      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should allow a self-healing overwrite for an over-budget key', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        keyLimits: { drafts: 10 },
        totalTokens: 18,
        memoryTokenMap: { drafts: 18 },
      });

      const result = await tool.func({
        key: 'drafts',
        value: '012345678',
      });
      expect(result[0]).toBe('Memory set for key "drafts" (9 tokens)');
      expect(mockSetMemory).toHaveBeenCalledWith({
        userId: 'test-user',
        key: 'drafts',
        value: '012345678',
        tokenCount: 9,
      });
    });

    it('should validate keys when validKeys is provided', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        validKeys: ['allowed', 'keys'],
      });

      const result = await tool.func({ key: 'invalid', value: 'some value' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Invalid key "invalid". Must be one of: allowed, keys');
      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should handle setMemory failure', async () => {
      mockSetMemory.mockResolvedValue({ ok: false });
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
      });

      const result = await tool.func({ key: 'test', value: 'some value' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Failed to set memory for key "test"');
      expect(result[1]).toBeUndefined();
    });

    it('should handle exceptions', async () => {
      mockSetMemory.mockRejectedValue(new Error('DB error'));
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
      });

      const result = await tool.func({ key: 'test', value: 'some value' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Error setting memory for key "test"');
      expect(result[1]).toBeUndefined();
    });
  });
});

describe('processMemory - GPT-5+ handling', () => {
  let mockSetMemory: jest.Mock;
  let mockDeleteMemory: jest.Mock;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMemory = jest.fn().mockResolvedValue({ ok: true });
    mockDeleteMemory = jest.fn().mockResolvedValue({ ok: true });
    mockRes = {
      headersSent: false,
      write: jest.fn(),
    };

    // Setup the Run.create mock
    const { Run } = jest.requireMock('@librechat/agents');
    (Run.create as jest.Mock).mockResolvedValue({
      processStream: jest.fn().mockResolvedValue('Memory processed'),
    });
  });

  it('should remove temperature for GPT-5 models', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-5',
        temperature: 0.7, // This should be removed
        maxTokens: 1000, // This should be moved to modelKwargs
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-5',
            modelKwargs: {
              max_completion_tokens: 1000,
            },
          }),
        }),
      }),
    );

    // Verify temperature was removed
    const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(callArgs.graphConfig.llmConfig.maxTokens).toBeUndefined();
  });

  it('should handle GPT-5+ models with existing modelKwargs', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-6',
        temperature: 0.8,
        maxTokens: 2000,
        modelKwargs: {
          customParam: 'value',
        },
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-6',
            modelKwargs: {
              customParam: 'value',
              max_completion_tokens: 2000,
            },
          }),
        }),
      }),
    );

    const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(callArgs.graphConfig.llmConfig.maxTokens).toBeUndefined();
  });

  it('should not modify non-GPT-5+ models', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 1000,
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-4',
            temperature: 0.7,
            maxTokens: 1000,
          }),
        }),
      }),
    );

    // Verify nothing was moved to modelKwargs for GPT-4
    const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.graphConfig.llmConfig.modelKwargs).toBeUndefined();
  });

  it('should handle various GPT-5+ model formats', async () => {
    const testCases = [
      { model: 'gpt-5', shouldTransform: true },
      { model: 'gpt-5-turbo', shouldTransform: true },
      { model: 'gpt-7-preview', shouldTransform: true },
      { model: 'gpt-9', shouldTransform: true },
      { model: 'gpt-4o', shouldTransform: false },
      { model: 'gpt-3.5-turbo', shouldTransform: false },
    ];

    for (const { model, shouldTransform } of testCases) {
      jest.clearAllMocks();
      const { Run } = jest.requireMock('@librechat/agents');
      (Run.create as jest.Mock).mockResolvedValue({
        processStream: jest.fn().mockResolvedValue('Memory processed'),
      });

      await processMemory({
        res: mockRes as Response,
        userId: 'test-user',
        setMemory: mockSetMemory,
        deleteMemory: mockDeleteMemory,
        messages: [],
        memory: 'Test memory',
        messageId: 'msg-123',
        conversationId: 'conv-123',
        instructions: 'Test instructions',
        llmConfig: {
          provider: Providers.OPENAI,
          model,
          temperature: 0.5,
          maxTokens: 1500,
        },
      });

      const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
      const llmConfig = callArgs.graphConfig.llmConfig;

      if (shouldTransform) {
        expect(llmConfig.temperature).toBeUndefined();
        expect(llmConfig.maxTokens).toBeUndefined();
        expect(llmConfig.modelKwargs?.max_completion_tokens).toBe(1500);
      } else {
        expect(llmConfig.temperature).toBe(0.5);
        expect(llmConfig.maxTokens).toBe(1500);
        expect(llmConfig.modelKwargs).toBeUndefined();
      }
    }
  });

  it('should use default model (gpt-4.1-mini) without temperature removal when no llmConfig provided', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      // No llmConfig provided
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-4.1-mini',
            temperature: 0.4, // Default temperature should remain
          }),
        }),
      }),
    );
  });

  it('should use max_output_tokens when useResponsesApi is true', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-5',
        maxTokens: 1000,
        useResponsesApi: true,
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-5',
            modelKwargs: {
              max_output_tokens: 1000,
            },
          }),
        }),
      }),
    );
  });

  it('should use max_completion_tokens when useResponsesApi is false or undefined', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-5',
        maxTokens: 1000,
        useResponsesApi: false,
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-5',
            modelKwargs: {
              max_completion_tokens: 1000,
            },
          }),
        }),
      }),
    );
  });
});
