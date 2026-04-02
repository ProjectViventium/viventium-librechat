const {
  buildProductivitySpecialistRuntimeInstructions,
  extractGoogleFileIds,
  hasExplicitProductivityRequest,
  reduceMessagesForProductivitySpecialist,
  resolveProductivitySpecialistScope,
  shouldIsolateProductivitySpecialistContext,
} = require('~/server/services/viventium/productivitySpecialistContext');

describe('productivitySpecialistContext', () => {
  test('extracts Google file IDs from pasted Docs links', () => {
    const ids = extractGoogleFileIds(
      'Check https://docs.google.com/document/d/1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c/edit and https://docs.google.com/document/d/18myiFuj2kJY7dmDUzR0lZgpVbJP_p0A-1kj9LXwPYXw/edit',
    );

    expect(ids).toEqual([
      '1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c',
      '18myiFuj2kJY7dmDUzR0lZgpVbJP_p0A-1kj9LXwPYXw',
    ]);
  });

  test('identifies Google productivity specialists from explicit config scope', () => {
    const scope = resolveProductivitySpecialistScope({
      activation: { intent_scope: 'productivity_google_workspace' },
    });

    expect(scope).toBe('google_workspace');
    expect(
      shouldIsolateProductivitySpecialistContext({
        activation: { intent_scope: 'productivity_google_workspace' },
      }),
    ).toBe(true);
  });

  test('does not infer productivity scope from names or tools without explicit scope', () => {
    const scope = resolveProductivitySpecialistScope({
      name: 'Google',
      tools: ['get_drive_file_content_mcp_google_workspace'],
    });

    expect(scope).toBeNull();
    expect(
      shouldIsolateProductivitySpecialistContext({
        name: 'Google',
        tools: ['get_drive_file_content_mcp_google_workspace'],
      }),
    ).toBe(false);
  });

  test('does not accept undocumented root-level intent_scope metadata', () => {
    expect(
      resolveProductivitySpecialistScope({
        intent_scope: 'productivity_ms365',
      }),
    ).toBeNull();
  });

  test('supports narrow legacy SCOPE header fallback without arbitrary instruction gating', () => {
    const scope = resolveProductivitySpecialistScope({
      instructions: `
        Legacy note
        SCOPE: productivity_google_workspace
      `,
    });

    expect(scope).toBe('google_workspace');
    expect(
      shouldIsolateProductivitySpecialistContext({
        instructions: `
          Legacy note
          SCOPE: productivity_google_workspace
        `,
      }),
    ).toBe(true);
    expect(
      shouldIsolateProductivitySpecialistContext({
        instructions: 'Do not reference memory systems or assumed prior context.',
      }),
    ).toBe(false);
  });

  test('rejects free-form provider aliases as productivity scope metadata', () => {
    expect(
      resolveProductivitySpecialistScope({
        activation: { intent_scope: 'gmail' },
      }),
    ).toBeNull();
    expect(
      resolveProductivitySpecialistScope({
        instructions: `
          Legacy note
          SCOPE: outlook
        `,
      }),
    ).toBeNull();
  });

  test('builds direct-retrieval runtime instructions for Google specialists', () => {
    const instructions = buildProductivitySpecialistRuntimeInstructions({
      agent: {
        activation: { intent_scope: 'productivity_google_workspace' },
      },
      latestUserText:
        'Read https://docs.google.com/document/d/1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c/edit',
    });

    expect(instructions).toContain('Latest user request: Read https://docs.google.com/document/d/');
    expect(instructions).toContain(
      'Detected Google file IDs: 1Ki8pi6Yl9q0VZ_kv9CXTApe29Gx_ThAPYp9impNvG4c',
    );
    expect(instructions).toContain('prefer direct Google Workspace retrieval tools');
  });

  test('detects explicit productivity requests without over-triggering generic chat turns', () => {
    expect(
      hasExplicitProductivityRequest('Check my inbox and tell me what happened in the past 10 days.'),
    ).toBe(true);
    expect(
      hasExplicitProductivityRequest('Please reply with exactly DIRECT_OK and nothing else.'),
    ).toBe(false);
  });

  test('keeps only relevant user turns for provider clarifications', () => {
    const reduced = reduceMessagesForProductivitySpecialist([
      { role: 'user', content: 'Check my inbox for replies from Joey.' },
      { role: 'assistant', content: 'Gmail or Outlook?' },
      { role: 'user', content: 'Outlook.' },
      { role: 'assistant', content: 'I could not finish that check just now.' },
    ]);

    expect(reduced).toHaveLength(2);
    expect(reduced[0].content).toBe('Check my inbox for replies from Joey.');
    expect(reduced[1].content).toBe('Outlook.');
  });
});
