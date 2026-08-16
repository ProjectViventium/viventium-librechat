const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockPluginService = {
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: jest.fn(),
  getUserPluginAuthValue: jest.fn(),
};

jest.mock('~/server/services/PluginService', () => mockPluginService);

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({
    // Default app config for tool tests
    paths: { uploads: '/tmp' },
    fileStrategy: 'local',
    filteredTools: [],
    includedTools: [],
  }),
  getCachedTools: jest.fn().mockResolvedValue({
    // Default cached tools for tests
    dalle: {
      type: 'function',
      function: {
        name: 'dalle',
        description: 'DALL-E image generation',
        parameters: {},
      },
    },
  }),
}));

const { Calculator } = require('@librechat/agents');

const { User } = require('~/db/models');
const PluginService = require('~/server/services/PluginService');
/* === VIVENTIUM START ===
 * Feature: Parallel Work tool authority.
 * Purpose: Exercise Viventium MCP audience and orchestration-facade policy at the upstream loader.
 */
const {
  validateTools,
  loadTools,
  loadToolWithAuth,
  canUseViventiumMCPServer,
} = require('./handleTools');
/* === VIVENTIUM END === */
const { StructuredSD, availableTools, DALLE3 } = require('../');

describe('Tool Handlers', () => {
  let mongoServer;
  let fakeUser;
  const pluginKey = 'dalle';
  const pluginKey2 = 'wolfram';
  const ToolClass = DALLE3;
  const initialTools = [pluginKey, pluginKey2];
  const mockCredential = 'mock-credential';
  const mainPlugin = availableTools.find((tool) => tool.pluginKey === pluginKey);
  const authConfigs = mainPlugin.authConfig;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    const userAuthValues = {};
    mockPluginService.getUserPluginAuthValue.mockImplementation((userId, authField) => {
      return userAuthValues[`${userId}-${authField}`];
    });
    mockPluginService.updateUserPluginAuth.mockImplementation(
      (userId, authField, _pluginKey, credential) => {
        const fields = authField.split('||');
        fields.forEach((field) => {
          userAuthValues[`${userId}-${field}`] = credential;
        });
      },
    );

    fakeUser = new User({
      name: 'Fake User',
      username: 'fakeuser',
      email: 'fakeuser@example.com',
      emailVerified: false,
      // file deepcode ignore NoHardcodedPasswords/test: fake value
      password: 'fakepassword123',
      avatar: '',
      provider: 'local',
      role: 'USER',
      googleId: null,
      plugins: [],
      refreshToken: [],
    });
    await fakeUser.save();
    for (const authConfig of authConfigs) {
      await PluginService.updateUserPluginAuth(
        fakeUser._id,
        authConfig.authField,
        pluginKey,
        mockCredential,
      );
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear mocks but not the database since we need the user to persist
    jest.clearAllMocks();

    // Reset the mock implementations
    const userAuthValues = {};
    mockPluginService.getUserPluginAuthValue.mockImplementation((userId, authField) => {
      return userAuthValues[`${userId}-${authField}`];
    });
    mockPluginService.updateUserPluginAuth.mockImplementation(
      (userId, authField, _pluginKey, credential) => {
        const fields = authField.split('||');
        fields.forEach((field) => {
          userAuthValues[`${userId}-${field}`] = credential;
        });
      },
    );

    // Re-add the auth configs for the user
    for (const authConfig of authConfigs) {
      await PluginService.updateUserPluginAuth(
        fakeUser._id,
        authConfig.authField,
        pluginKey,
        mockCredential,
      );
    }
  });

  describe('validateTools', () => {
    it('returns valid tools given input tools and user authentication', async () => {
      const validTools = await validateTools(fakeUser._id, initialTools);
      expect(validTools).toBeDefined();
      expect(validTools.some((tool) => tool === pluginKey)).toBeTruthy();
      expect(validTools.length).toBeGreaterThan(0);
    });

    it('removes tools without valid credentials from the validTools array', async () => {
      const validTools = await validateTools(fakeUser._id, initialTools);
      expect(validTools.some((tool) => tool.pluginKey === pluginKey2)).toBeFalsy();
    });

    it('returns an empty array when no authenticated tools are provided', async () => {
      const validTools = await validateTools(fakeUser._id, []);
      expect(validTools).toEqual([]);
    });

    it('should validate a tool from an Environment Variable', async () => {
      const plugin = availableTools.find((tool) => tool.pluginKey === pluginKey2);
      const authConfigs = plugin.authConfig;
      for (const authConfig of authConfigs) {
        process.env[authConfig.authField] = mockCredential;
      }
      const validTools = await validateTools(fakeUser._id, [pluginKey2]);
      expect(validTools.length).toEqual(1);
      for (const authConfig of authConfigs) {
        delete process.env[authConfig.authField];
      }
    });
  });

  /* === VIVENTIUM START ===
   * Feature: Parallel Work tool authority.
   * Purpose: Keep owner-only MCP and Main-only mission controls fail closed.
   */
  describe('Viventium MCP audience policy', () => {
    const ownerOnlyConfig = {
      viventiumAccess: { audience: 'local_owner' },
    };

    it('allows ordinary MCP servers for an authenticated user', () => {
      expect(canUseViventiumMCPServer({ serverConfig: {}, reqUser: { role: 'USER' } })).toBe(true);
    });

    it('fails closed for owner-only MCP servers when request identity is absent', () => {
      expect(canUseViventiumMCPServer({ serverConfig: ownerOnlyConfig, reqUser: undefined })).toBe(
        false,
      );
    });

    it('denies owner-only MCP servers to non-admin users', () => {
      expect(
        canUseViventiumMCPServer({
          serverConfig: ownerOnlyConfig,
          reqUser: { role: 'USER' },
        }),
      ).toBe(false);
    });

    it('allows owner-only MCP servers to the local owner role', () => {
      expect(
        canUseViventiumMCPServer({
          serverConfig: ownerOnlyConfig,
          reqUser: { role: 'ADMIN' },
        }),
      ).toBe(true);
    });
  });

  describe('Viventium universal Main orchestration facade', () => {
    const originalAvailable = process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE;

    beforeEach(() => {
      process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
      require('~/server/services/viventium/GlassHiveOrchestrationReadinessService').resetOrchestrationReadinessForTests(
        { status: 'ready', checkedAtMs: Date.now() },
      );
    });

    afterAll(() => {
      if (originalAvailable === undefined) delete process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE;
      else process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = originalAvailable;
      require('~/server/services/viventium/GlassHiveOrchestrationReadinessService').resetOrchestrationReadinessForTests();
    });

    it('substitutes the Core facade for a default OpenAI Main without raw MCP discovery', async () => {
      const toolMap = await loadTools({
        user: fakeUser._id,
        agent: {
          id: 'main-agent',
          provider: 'openAI',
          glasshive_options: { orchestration: { parallel_available: true } },
        },
        endpoint: 'openAI',
        tools: ['worker_delegate_once_mcp_glasshive-workers-projects'],
        options: { req: { user: { id: String(fakeUser._id), role: 'USER' } } },
        returnMap: true,
      });

      expect(toolMap).toHaveProperty('worker_delegate_once_mcp_glasshive-workers-projects');
      const facade = await toolMap['worker_delegate_once_mcp_glasshive-workers-projects']();
      expect(facade.name).toBe('worker_delegate_once_mcp_glasshive-workers-projects');
      expect(
        facade.schema.safeParse({
          title: 'A',
          instruction: 'Research A',
          sourceOrdinals: [1],
        }).success,
      ).toBe(true);
    });

    it('does not expose launch or work controls to a mission/root Agent', async () => {
      const toolMap = await loadTools({
        user: fakeUser._id,
        agent: { id: 'mission-root', provider: 'openAI' },
        endpoint: 'openAI',
        tools: [
          'worker_delegate_once_mcp_glasshive-workers-projects',
          'active_work_list',
          'active_work_action',
        ],
        options: { req: { user: { id: String(fakeUser._id), role: 'USER' } } },
        returnMap: true,
      });

      expect(toolMap).toEqual({});
    });

    it('keeps only existing-work list/action available to Main during readiness rollback', async () => {
      require('~/server/services/viventium/GlassHiveOrchestrationReadinessService').resetOrchestrationReadinessForTests(
        { status: 'unready', checkedAtMs: Date.now() },
      );

      const toolMap = await loadTools({
        user: fakeUser._id,
        agent: {
          id: 'main-agent',
          provider: 'openAI',
          glasshive_options: { orchestration: { parallel_available: true } },
        },
        endpoint: 'openAI',
        tools: [
          'worker_delegate_once_mcp_glasshive-workers-projects',
          'active_work_list',
          'active_work_action',
        ],
        options: {
          req: {
            user: {
              id: String(fakeUser._id),
              role: 'USER',
              personalization: { parallel_work_known: true },
            },
          },
        },
        returnMap: true,
      });

      expect(toolMap).not.toHaveProperty('worker_delegate_once_mcp_glasshive-workers-projects');
      expect(toolMap).toHaveProperty('active_work_list');
      expect(toolMap).toHaveProperty('active_work_action');
    });

    it('keeps rollback focused+known-false and mission roots capability-empty', async () => {
      require('~/server/services/viventium/GlassHiveOrchestrationReadinessService').resetOrchestrationReadinessForTests(
        { status: 'unavailable', checkedAtMs: Date.now() },
      );
      const requestedTools = [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ];
      const req = {
        user: {
          id: String(fakeUser._id),
          role: 'USER',
          personalization: { orchestration_mode: 'focused', parallel_work_known: false },
        },
      };

      const focusedMain = await loadTools({
        user: fakeUser._id,
        agent: {
          id: 'main-agent',
          provider: 'openAI',
          glasshive_options: { orchestration: { parallel_available: true } },
        },
        endpoint: 'openAI',
        tools: requestedTools,
        options: { req },
        returnMap: true,
      });
      const missionRoot = await loadTools({
        user: fakeUser._id,
        agent: { id: 'mission-root', provider: 'openAI' },
        endpoint: 'openAI',
        tools: requestedTools,
        options: {
          req: {
            ...req,
            user: {
              ...req.user,
              personalization: { parallel_work_known: true },
            },
          },
        },
        returnMap: true,
      });

      expect(focusedMain).toEqual({});
      expect(missionRoot).toEqual({});
    });
  });

  /* === VIVENTIUM END === */

  describe('loadTools', () => {
    let toolFunctions;
    let loadTool1;
    let loadTool2;
    let loadTool3;
    const sampleTools = [...initialTools, 'calculator'];
    let ToolClass2 = Calculator;
    let remainingTools = availableTools.filter(
      (tool) => sampleTools.indexOf(tool.pluginKey) === -1,
    );

    beforeAll(async () => {
      const toolMap = await loadTools({
        user: fakeUser._id,
        tools: sampleTools,
        returnMap: true,
        useSpecs: true,
      });
      toolFunctions = toolMap;
      loadTool1 = toolFunctions[sampleTools[0]];
      loadTool2 = toolFunctions[sampleTools[1]];
      loadTool3 = toolFunctions[sampleTools[2]];
    });

    let originalEnv;

    beforeEach(() => {
      originalEnv = process.env;
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns the expected load functions for requested tools', async () => {
      expect(loadTool1).toBeDefined();
      expect(loadTool2).toBeDefined();
      expect(loadTool3).toBeDefined();

      for (const tool of remainingTools) {
        expect(toolFunctions[tool.pluginKey]).toBeUndefined();
      }
    });

    it('should initialize an authenticated tool or one without authentication', async () => {
      const authTool = await loadTool1();
      const tool = await loadTool3();
      expect(authTool).toBeInstanceOf(ToolClass);
      expect(tool).toBeInstanceOf(ToolClass2);
    });

    it('should initialize an authenticated tool with primary auth field', async () => {
      process.env.DALLE3_API_KEY = 'mocked_api_key';
      const initToolFunction = loadToolWithAuth(
        'userId',
        ['DALLE3_API_KEY||DALLE_API_KEY'],
        ToolClass,
      );
      const authTool = await initToolFunction();

      expect(authTool).toBeInstanceOf(ToolClass);
      expect(mockPluginService.getUserPluginAuthValue).not.toHaveBeenCalled();
    });

    it('should initialize an authenticated tool with alternate auth field when primary is missing', async () => {
      delete process.env.DALLE3_API_KEY; // Ensure the primary key is not set
      process.env.DALLE_API_KEY = 'mocked_alternate_api_key';
      const initToolFunction = loadToolWithAuth(
        'userId',
        ['DALLE3_API_KEY||DALLE_API_KEY'],
        ToolClass,
      );
      const authTool = await initToolFunction();

      expect(authTool).toBeInstanceOf(ToolClass);
      expect(mockPluginService.getUserPluginAuthValue).toHaveBeenCalledTimes(1);
      expect(mockPluginService.getUserPluginAuthValue).toHaveBeenCalledWith(
        'userId',
        'DALLE3_API_KEY',
        true,
      );
    });

    it('should fallback to getUserPluginAuthValue when env vars are missing', async () => {
      mockPluginService.updateUserPluginAuth('userId', 'DALLE_API_KEY', 'dalle', 'mocked_api_key');
      const initToolFunction = loadToolWithAuth(
        'userId',
        ['DALLE3_API_KEY||DALLE_API_KEY'],
        ToolClass,
      );
      const authTool = await initToolFunction();

      expect(authTool).toBeInstanceOf(ToolClass);
      expect(mockPluginService.getUserPluginAuthValue).toHaveBeenCalledTimes(2);
    });

    it('should throw an error for an unauthenticated tool', async () => {
      try {
        await loadTool2();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
    it('returns an empty object when no tools are requested', async () => {
      toolFunctions = await loadTools({
        user: fakeUser._id,
        returnMap: true,
        useSpecs: true,
      });
      expect(toolFunctions).toEqual({});
    });
    it('should return the StructuredTool version when using functions', async () => {
      process.env.SD_WEBUI_URL = mockCredential;
      toolFunctions = await loadTools({
        user: fakeUser._id,
        tools: ['stable-diffusion'],
        functions: true,
        returnMap: true,
        useSpecs: true,
      });
      const structuredTool = await toolFunctions['stable-diffusion']();
      expect(structuredTool).toBeInstanceOf(StructuredSD);
      delete process.env.SD_WEBUI_URL;
    });
  });
});
