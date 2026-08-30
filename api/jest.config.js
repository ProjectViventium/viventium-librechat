const fs = require('fs');
const path = require('path');

const esModules = [
  'openid-client',
  'oauth4webapi',
  'jose',
  '@langchain/langgraph',
  '@langchain/langgraph-checkpoint',
  '@langchain/langgraph-sdk',
  '@mistralai/mistralai',
  'uuid',
].join('|');

const viventiumProductionRoot = path.resolve(
  process.env.VIVENTIUM_TEST_PRODUCTION_ROOT || path.resolve(__dirname, '../../..'),
);
const hasParentReleaseContracts = [
  'parallel_work_release_gate.py',
  'qa_release_attestation.py',
  'runtime_owner_command_contract.json',
  'parallel_work_runtime_artifact_manifest.json',
].every((name) => fs.existsSync(path.join(viventiumProductionRoot, 'scripts', 'viventium', name)));

module.exports = {
  testEnvironment: 'node',
  clearMocks: true,
  roots: ['<rootDir>'],
  coverageDirectory: 'coverage',
  testTimeout: 120000, // Full-suite MongoMemoryServer startups can exceed 30s under load
  // This integration contract owns parent Viventium release scripts and runs in a full checkout.
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(!hasParentReleaseContracts
      ? [
          '/server/services/viventium/__tests__/ViventiumOrchestrationMode\\.spec\\.js$',
          '/server/routes/viventium/__tests__/orchestration\\.spec\\.js$',
        ]
      : []),
  ],
  setupFiles: ['./test/jestSetup.js', './test/__mocks__/logger.js'],
  moduleNameMapper: {
    '~/(.*)': '<rootDir>/$1',
    '~/data/auth.json': '<rootDir>/__mocks__/auth.mock.json',
    '^openid-client/passport$': '<rootDir>/test/__mocks__/openid-client-passport.js', // Mock for the passport strategy part
    '^openid-client$': '<rootDir>/test/__mocks__/openid-client.js',
  },
  transform: {
    '\\.[jt]sx?$': [
      'babel-jest',
      {
        presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
      },
    ],
  },
  transformIgnorePatterns: [`/node_modules/(?!(${esModules})/).*`],
};
