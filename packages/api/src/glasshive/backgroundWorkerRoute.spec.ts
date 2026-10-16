import {
  configuredBackgroundWorkerRoute,
  backgroundWorkerResources,
  resolveBackgroundWorkerRoute,
} from './backgroundWorkerRoute';

describe('independent background preferences', () => {
  test.each(['direct-openai', 'direct-anthropic', 'direct-xai'])(
    'preserves registered Direct worker routes for %s',
    (profile) => {
      const preferences = {
        worker_profile: profile,
        worker_model: `${profile}:configured-model`,
        worker_reasoning_effort: 'high',
        fallback_worker_profile: profile,
        fallback_worker_model: `${profile}:fallback-model`,
        fallback_worker_reasoning_effort: 'low',
      };
      for (const agent of [
        { orchestration: preferences },
        { glasshive_options: { orchestration: preferences } },
      ]) {
        const route = configuredBackgroundWorkerRoute(agent);
        expect(backgroundWorkerResources(route)).toEqual(preferences);
        expect(resolveBackgroundWorkerRoute({}, backgroundWorkerResources(route))).toEqual({
          args: { profile, effort: 'high' },
          authority: {
            worker_model: preferences.worker_model,
            worker_reasoning_effort: 'high',
            fallback_worker_profile: profile,
            fallback_worker_model: preferences.fallback_worker_model,
            fallback_worker_reasoning_effort: 'low',
          },
        });
      }
    },
  );
  const orchestration = {
    worker_profile: 'codex-cli',
    worker_model: 'codex-cli:configured-model',
    worker_reasoning_effort: 'medium',
    fallback_worker_profile: 'claude-code',
    fallback_worker_model: 'claude-code:configured-model',
    fallback_worker_reasoning_effort: 'medium',
  };
  test('uses persisted background settings independently of foreground settings on both descriptor shapes', () => {
    const full = configuredBackgroundWorkerRoute({
      model_parameters: { reasoning_effort: 'low' },
      glasshive_options: { orchestration },
    });
    expect(backgroundWorkerResources(full)).toEqual(orchestration);
    expect(configuredBackgroundWorkerRoute({ orchestration })).toEqual(full);
    expect(resolveBackgroundWorkerRoute({ title: 'task' }, orchestration)).toEqual({
      args: { title: 'task', profile: 'codex-cli', effort: 'medium' },
      authority: {
        worker_model: orchestration.worker_model,
        worker_reasoning_effort: 'medium',
        fallback_worker_profile: 'claude-code',
        fallback_worker_model: orchestration.fallback_worker_model,
        fallback_worker_reasoning_effort: 'medium',
      },
    });
  });
  test('preserves explicit effort and does not lend a model or effort to a different requested profile', () => {
    expect(
      resolveBackgroundWorkerRoute({ profile: 'codex-cli', effort: 'high' }, orchestration)
        .authority.worker_reasoning_effort,
    ).toBe('high');
    const other = resolveBackgroundWorkerRoute({ profile: 'openclaw-general' }, orchestration);
    expect(other.args).toEqual({ profile: 'openclaw-general' });
    expect(other.authority.worker_model).toBeUndefined();
    expect(other.authority.worker_reasoning_effort).toBeUndefined();
  });
  test('retains legacy profile-only routes and excludes malformed preferences', () => {
    expect(resolveBackgroundWorkerRoute({}, { worker_profile: 'codex-cli' })).toEqual({
      args: { profile: 'codex-cli' },
      authority: {},
    });
    expect(
      configuredBackgroundWorkerRoute({
        orchestration: {
          worker_profile: 'invalid',
          worker_model: {},
          worker_reasoning_effort: 'x'.repeat(161),
        },
      }),
    ).toEqual({});
  });
});

test.each(['ask', 'full'])(
  'keeps explicit owner background native access %s separate from Main and model arguments',
  (access) => {
    const route = configuredBackgroundWorkerRoute({
      glasshive_options: {
        access: access === 'full' ? 'workspace' : 'full',
        orchestration: { worker_access: access },
      },
    });
    expect(backgroundWorkerResources(route)).toEqual({ worker_access: access });
    expect(
      resolveBackgroundWorkerRoute({ worker_access: 'full' }, backgroundWorkerResources(route))
        .authority,
    ).toEqual({ worker_access: access });
    expect(resolveBackgroundWorkerRoute({ worker_access: 'full' }, {}).authority).toEqual({});
    expect(configuredBackgroundWorkerRoute({ glasshive_options: { access: 'full' } })).toEqual({});
  },
);
test.each(['workspace', 'read_only', 'bypass', true])(
  'rejects unsupported background native access %s',
  (access) => {
    expect(configuredBackgroundWorkerRoute({ orchestration: { worker_access: access } })).toEqual(
      {},
    );
    expect(resolveBackgroundWorkerRoute({}, { worker_access: access }).authority).toEqual({});
  },
);
