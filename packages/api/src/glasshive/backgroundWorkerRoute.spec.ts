import {
  configuredBackgroundWorkerRoute,
  backgroundWorkerResources,
  resolveBackgroundWorkerRoute,
} from './backgroundWorkerRoute';

describe('independent background preferences', () => {
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
