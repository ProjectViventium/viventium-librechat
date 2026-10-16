import { glassHiveOptionsSchema, applyAgentProviderCapabilityDefaults } from './validation';
const options = {
  workspace: { mode: 'life' },
  access: 'full',
  orchestration: {
    parallel_available: true,
    default_mode: 'parallel',
    worker_profile: 'codex-cli',
    worker_model: 'codex-cli:example',
    worker_reasoning_effort: 'medium',
    fallback_worker_profile: 'claude-code',
    fallback_worker_model: 'claude-code:example',
    fallback_worker_reasoning_effort: 'low',
  },
};
it('preserves all independent typed worker preferences', () => {
  expect(glassHiveOptionsSchema.parse(options)).toEqual(options);
});
it('keeps existing profile-only configuration valid', () => {
  const old = {
    ...options,
    orchestration: {
      parallel_available: true,
      default_mode: 'parallel',
      worker_profile: 'codex-cli',
    },
  };
  expect(glassHiveOptionsSchema.parse(old)).toEqual(old);
});
it.each([
  'worker_model',
  'worker_reasoning_effort',
  'fallback_worker_model',
  'fallback_worker_reasoning_effort',
])('rejects non-string %s values', (key) => {
  expect(
    glassHiveOptionsSchema.safeParse({
      ...options,
      orchestration: { ...options.orchestration, [key]: { arbitrary: true } },
    }).success,
  ).toBe(false);
});
it('continues rejecting undeclared orchestration properties', () => {
  expect(
    glassHiveOptionsSchema.safeParse({
      ...options,
      orchestration: { ...options.orchestration, ownerOverride: 'foreign' },
    }).success,
  ).toBe(false);
});

it.each(['ask', 'full'])(
  'persists owner native access %s without inheriting foreground access',
  (worker_access) => {
    const explicit = { ...options, orchestration: { ...options.orchestration, worker_access } };
    expect(glassHiveOptionsSchema.parse(explicit)).toEqual(explicit);
    expect(glassHiveOptionsSchema.parse(options).orchestration).not.toHaveProperty('worker_access');
  },
);
it.each(['workspace', 'read_only', 'bypass', true])(
  'rejects unsupported native permission %s',
  (worker_access) => {
    expect(
      glassHiveOptionsSchema.safeParse({
        ...options,
        orchestration: { ...options.orchestration, worker_access },
      }).success,
    ).toBe(false);
  },
);

it('uses the existing configured full-access policy for the independent background grant', () => {
  const selection = {
    provider: 'harness',
    model: 'synthetic',
    glasshive_options: {
      ...options,
      access: 'workspace',
      orchestration: {
        ...options.orchestration,
        worker_profile: 'grok-build',
        worker_access: 'full',
      },
    },
  };
  expect(() =>
    applyAgentProviderCapabilityDefaults(selection, {
      harness: {
        main_chat: true,
        models: [{ id: 'synthetic' }],
        workspace_binding: true,
        allow_full_access: false,
      },
    }),
  ).toThrow('does not permit full host access');
  expect(
    applyAgentProviderCapabilityDefaults(selection, {
      harness: {
        main_chat: true,
        models: [{ id: 'synthetic' }],
        workspace_binding: true,
        allow_full_access: true,
      },
    }).glasshive_options,
  ).toMatchObject({ access: 'workspace', orchestration: { worker_access: 'full' } });
});

it('rejects saved full access when both declared routes leave Grok', () => {
  expect(() =>
    applyAgentProviderCapabilityDefaults(
      {
        provider: 'harness',
        model: 'synthetic',
        glasshive_options: {
          ...options,
          orchestration: { ...options.orchestration, worker_access: 'full' },
        },
      },
      {
        harness: {
          main_chat: true,
          models: [{ id: 'synthetic' }],
          workspace_binding: true,
          allow_full_access: true,
        },
      },
    ),
  ).toThrow('requires a declared Grok');
});
