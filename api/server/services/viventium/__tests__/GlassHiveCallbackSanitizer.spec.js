const { sanitizeGlassHiveCallbackText } = require('../GlassHiveCallbackSanitizer');

describe('GlassHiveCallbackSanitizer', () => {
  test('redacts credential-shaped values and local plumbing before durable evidence persistence', () => {
    const raw = [
      'Bearer abcdefghijklmnopqrstuvwxyz123456',
      'api_key=syntheticbutsecretvalue12345',
      'Worker wrk_synthetic run_synthetic wrote /Users/example/private/result.md.',
    ].join('\n');

    const result = sanitizeGlassHiveCallbackText(raw, { maxLength: 10_000 });
    expect(result).toContain('Bearer [secret]');
    expect(result).toContain('api_key=[secret]');
    expect(result).toContain('[worker id]');
    expect(result).toContain('[run id]');
    expect(result).toContain('[local path]');
    expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(result).not.toContain('syntheticbutsecretvalue12345');
  });
});
