import { glassHiveOptionsSchema } from './validation';
const options = { workspace: { mode: 'life' }, access: 'full', orchestration: {
  parallel_available: true, default_mode: 'parallel', worker_profile: 'codex-cli',
  worker_model: 'codex-cli:example', worker_reasoning_effort: 'medium',
  fallback_worker_profile: 'claude-code', fallback_worker_model: 'claude-code:example',
  fallback_worker_reasoning_effort: 'low',
} };
it('preserves all independent typed worker preferences', () => {
  expect(glassHiveOptionsSchema.parse(options)).toEqual(options);
});
it('keeps existing profile-only configuration valid', () => {
  const old = {...options,orchestration:{parallel_available:true,default_mode:'parallel',worker_profile:'codex-cli'}};
  expect(glassHiveOptionsSchema.parse(old)).toEqual(old);
});
it.each(['worker_model','worker_reasoning_effort','fallback_worker_model','fallback_worker_reasoning_effort'])(
  'rejects non-string %s values', (key) => {
    expect(glassHiveOptionsSchema.safeParse({...options,orchestration:{...options.orchestration,[key]:{arbitrary:true}}}).success).toBe(false);
  });
it('continues rejecting undeclared orchestration properties', () => {
  expect(glassHiveOptionsSchema.safeParse({...options,orchestration:{...options.orchestration,ownerOverride:'foreign'}}).success).toBe(false);
});
