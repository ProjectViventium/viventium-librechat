import { isSafeGlassHiveActionUrl, sanitizeGlassHiveCallbackText } from './callbackSanitizer';

describe('GlassHive callback sanitizer', () => {
  test.each([
    '[checklist]([REDACTED_LOCAL_PATH]',
    '[checklist]([REDACTED_LOCAL_PATH])',
    '[checklist](/Users/synthetic/mission/checklist.pdf)',
  ])('keeps the useful label when a local artifact destination is redacted: %s', (link) => {
    const artifactUrl = 'http://127.0.0.1:8780/v1/link-refs/ghr_1234567890abcdef';
    const text = `Created the ${link}\n\nCovers opening and closing.\nDownload: [PDF](${artifactUrl})`;

    expect(sanitizeGlassHiveCallbackText(text)).toBe(
      `Created the checklist\n\nCovers opening and closing.\nDownload: [PDF](${artifactUrl})`,
    );
  });

  test('preserves loopback artifact link references while redacting arbitrary local URLs', () => {
    const artifactUrl =
      'http://127.0.0.1:8780/v1/link-refs/ghr_1234567890abcdef';
    const unsafeUrl = 'http://127.0.0.1:8780/private/debug';
    const text = `Preview: [Open GlassHive file](${artifactUrl})\nDebug: ${unsafeUrl}`;

    expect(isSafeGlassHiveActionUrl(artifactUrl)).toBe(true);
    expect(sanitizeGlassHiveCallbackText(text)).toBe(
      `Preview: [Open GlassHive file](${artifactUrl})\nDebug: [local worker link]`,
    );
  });
});


describe('owner-scoped result fidelity', () => {
  test('preserves authorized owner paths and ordinary run text while still removing secrets', () => {
    const text = 'Open /Users/synthetic/reports/final.pdf and run_tests after a run-through. password=abcdefghijklmnop';
    const owner = sanitizeGlassHiveCallbackText(text, { ownerResult: true });
    expect(owner).toContain('/Users/synthetic/reports/final.pdf');
    expect(owner).toContain('run_tests after a run-through');
    expect(owner).toContain('password=[secret]');
    expect(owner).not.toContain('abcdefghijklmnop');
    expect(sanitizeGlassHiveCallbackText(text)).toContain('[local path]');
    expect(sanitizeGlassHiveCallbackText(text)).not.toContain('/Users/synthetic');
  });
  test('redacts only actual opaque runtime IDs rather than run words', () => {
    expect(sanitizeGlassHiveCallbackText('run_tests run-through run_a1b2c3d4e5 wrk_a1b2c3d4e5')).toBe(
      'run_tests run-through [run id] [worker id]',
    );
  });
});
