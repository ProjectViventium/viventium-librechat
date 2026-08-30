import { buildWebSearchContext } from './web';

describe('buildWebSearchContext', () => {
  test('keeps the direct-provider timestamp block by default', () => {
    const context = buildWebSearchContext();

    expect(context).toMatch(
      /^# `web_search`:\nCurrent Date & Time: .+\n\n\*\*Execute immediately without preface\.\*\*/,
    );
  });

  test('omits volatile time from durable native-session authority', () => {
    const context = buildWebSearchContext({ includeCurrentTime: false });

    expect(context).not.toContain('Current Date & Time:');
    expect(context).toMatch(/^# `web_search`:\n\n\*\*Execute immediately without preface\.\*\*/);
  });
});
