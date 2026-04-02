import { resolveSelectedAgentIdForApply } from './selection';

describe('resolveSelectedAgentIdForApply', () => {
  it('prefers the agent loaded in the builder form over the previously pinned agent', () => {
    expect(resolveSelectedAgentIdForApply('agent-viventium', 'agent-background')).toBe(
      'agent-background',
    );
  });

  it('falls back to the panel current agent id when the form has no selected agent', () => {
    expect(resolveSelectedAgentIdForApply('agent-viventium', undefined)).toBe('agent-viventium');
  });

  it('returns an empty string when neither id is available', () => {
    expect(resolveSelectedAgentIdForApply(undefined, undefined)).toBe('');
  });
});
