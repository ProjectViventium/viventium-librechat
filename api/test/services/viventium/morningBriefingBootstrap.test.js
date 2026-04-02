/* === VIVENTIUM START ===
 * Purpose: Tests for the morningBriefingBootstrap service.
 * === VIVENTIUM END === */

const { ensureMorningBriefing, TEMPLATE_ID } = require('~/server/services/viventium/morningBriefingBootstrap');

describe('morningBriefingBootstrap', () => {
  const originalEnv = { ...process.env };
  let fetchMock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.VIVENTIUM_MORNING_BRIEFING_BOOTSTRAP_ENABLED = 'true';
    process.env.SCHEDULING_MCP_URL = 'http://localhost:7010';
    process.env.VIVENTIUM_MAIN_AGENT_ID = 'agent_test_123';

    fetchMock = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: 'created', task_id: 'task-new-1' }),
    });
    global.fetch = fetchMock;

    // Reset the in-memory bootstrapped set between tests
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    // Clear the module-level Set by re-requiring
    jest.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  it('has correct TEMPLATE_ID', () => {
    expect(TEMPLATE_ID).toBe('morning_briefing_default_v1');
  });

  it('does not call fetch when bootstrap is disabled', async () => {
    process.env.VIVENTIUM_MORNING_BRIEFING_BOOTSTRAP_ENABLED = 'false';
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    await mod.ensureMorningBriefing({ userId: 'user-1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call fetch when userId is missing', async () => {
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    await mod.ensureMorningBriefing({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls bootstrap endpoint with correct payload', async () => {
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    global.fetch = fetchMock;

    await mod.ensureMorningBriefing({
      userId: 'user-1',
      clientTimezone: 'America/Toronto',
      surface: 'web',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:7010/internal/bootstrap-schedule');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.user_id).toBe('user-1');
    expect(body.template_id).toBe('morning_briefing_default_v1');
    expect(body.timezone).toBe('America/Toronto');
    expect(body.channels).toBeNull();
    expect(body.metadata.bootstrap_surface).toBe('web');
  });

  it('skips second call for same user (in-memory dedup)', async () => {
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    global.fetch = fetchMock;

    await mod.ensureMorningBriefing({ userId: 'user-1' });
    await mod.ensureMorningBriefing({ userId: 'user-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls for different users', async () => {
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    global.fetch = fetchMock;

    await mod.ensureMorningBriefing({ userId: 'user-1' });
    await mod.ensureMorningBriefing({ userId: 'user-2' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not throw on fetch failure', async () => {
    const mod = require('~/server/services/viventium/morningBriefingBootstrap');
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    await expect(
      mod.ensureMorningBriefing({ userId: 'user-fail' }),
    ).resolves.toBeUndefined();
  });
});
