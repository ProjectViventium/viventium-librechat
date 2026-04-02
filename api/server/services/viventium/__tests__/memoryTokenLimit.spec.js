/* === VIVENTIUM START ===
 * Tests: Memory token limit override helper
 *
 * Purpose:
 * - Ensure env override takes precedence over config token limit.
 * - Preserve config/default behavior when override is absent or invalid.
 *
 * Added: 2026-02-20
 * === VIVENTIUM END === */

describe('memoryTokenLimit', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.VIVENTIUM_MEMORY_TOKEN_LIMIT_OVERRIDE;
  });

  test('uses env override when provided', () => {
    process.env.VIVENTIUM_MEMORY_TOKEN_LIMIT_OVERRIDE = '8000';
    const { resolveMemoryTokenLimit } = require('../memoryTokenLimit');

    expect(resolveMemoryTokenLimit(18000)).toBe(8000);
  });

  test('falls back to config token limit when override is absent', () => {
    const { resolveMemoryTokenLimit } = require('../memoryTokenLimit');

    expect(resolveMemoryTokenLimit(18000)).toBe(18000);
  });

  test('ignores invalid override values', () => {
    process.env.VIVENTIUM_MEMORY_TOKEN_LIMIT_OVERRIDE = 'not-a-number';
    const { resolveMemoryTokenLimit } = require('../memoryTokenLimit');

    expect(resolveMemoryTokenLimit(18000)).toBe(18000);
  });
});
