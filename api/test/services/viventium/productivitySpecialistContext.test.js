const {
  resolveProductivitySpecialistScope,
} = require('~/server/services/viventium/productivitySpecialistContext');

describe('productivitySpecialistContext', () => {
  test.each(['google_workspace', 'ms365'])('uses declared %s ownership', (scope) => {
    expect(
      resolveProductivitySpecialistScope({
        activation: { intent_scope: `productivity_${scope}` },
      }),
    ).toBe(scope);
    expect(resolveProductivitySpecialistScope({}, { scope })).toBe(scope);
  });
  test('ignores names, tools and legacy instruction headers', () => {
    expect(
      resolveProductivitySpecialistScope({
        name: 'Google',
        tools: ['get_drive_file_content_mcp_google_workspace'],
        instructions: 'SCOPE: productivity_google_workspace',
      }),
    ).toBeNull();
    expect(
      resolveProductivitySpecialistScope({
        activation: { prompt: 'SCOPE: productivity_ms365' },
      }),
    ).toBeNull();
  });
  test('does not accept undocumented aliases or root-level scope', () => {
    expect(
      resolveProductivitySpecialistScope({
        activation: { intent_scope: 'gmail' },
      }),
    ).toBeNull();
    expect(
      resolveProductivitySpecialistScope({
        intent_scope: 'productivity_ms365',
      }),
    ).toBeNull();
  });
  test('typed scope remains authoritative over a conflicting prose header', () => {
    expect(
      resolveProductivitySpecialistScope({
        activation: { intent_scope: 'productivity_ms365' },
        instructions: 'SCOPE: productivity_google_workspace',
      }),
    ).toBe('ms365');
  });
});
