/* === VIVENTIUM START ===
 * Feature: secret-safe structured logging
 * Purpose: prevent provider credentials from reaching debug or ordinary logs.
 * === VIVENTIUM END === */
import { debugTraverse, redactMessage } from './parsers';

describe('Viventium log redaction', () => {
  it('redacts common credential forms in ordinary messages', () => {
    const input = [
      'Bearer synthetic-bearer-value',
      'api_key=synthetic-api-value',
      'ghp_syntheticgithubvalue',
      'xoxb-synthetic-slack-value',
      'eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.c2lnbmF0dXJl',
    ].join(' ');

    const output = redactMessage(input);

    expect(output).not.toContain('synthetic-bearer-value');
    expect(output).not.toContain('synthetic-api-value');
    expect(output).not.toContain('syntheticgithubvalue');
    expect(output).not.toContain('synthetic-slack-value');
    expect(output).not.toContain('c3ludGhldGlj');
  });

  it('redacts nested custom-endpoint credentials from debug formatting', () => {
    const info: Record<string | symbol, unknown> = {
      level: 'debug',
      message: 'Custom config:',
      timestamp: '2026-07-30T00:00:00.000Z',
      [Symbol.for('splat')]: [
        {
          endpoints: {
            custom: [
              {
                name: 'GlassHive',
                apiKey: 'synthetic-provider-secret',
                headers: { Authorization: 'Bearer synthetic-header-secret' },
              },
            ],
          },
        },
      ],
    };

    const transformed = debugTraverse.transform(info, debugTraverse.options) as Record<
      string | symbol,
      unknown
    >;
    const output = String(transformed[Symbol.for('message')] ?? '');

    expect(output).toContain('GlassHive');
    expect(output).not.toContain('synthetic-provider-secret');
    expect(output).not.toContain('synthetic-header-secret');
    expect(output).toContain('[REDACTED]');
  });
});
