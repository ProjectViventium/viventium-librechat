/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const {
  DEFAULT_BASE_DIR,
  buildOwnerGrantRequests,
  parseArgs,
  resolveSelections,
  sanitizeEmailForPath,
} = require('../../../scripts/viv-user-sync');

describe('viv-user-sync script args', () => {
  test('parseArgs captures action, email, sections, and mongo uri', () => {
    const args = parseArgs([
      'pull',
      '--user-email=Test+User@Example.com',
      '--memories',
      '--agents',
      '--dir=tmp/export',
      '--mongo-uri=mongodb+srv://user:pass@cluster0.example.mongodb.net/LibreChat?appName=Cluster0',
    ]);

    expect(args.action).toBe('pull');
    expect(args.userEmail).toBe('Test+User@Example.com');
    expect(args.memories).toBe(true);
    expect(args.agents).toBe(true);
    expect(args.baseDir).toBe('tmp/export');
    expect(args.mongoUri).toBe(
      'mongodb+srv://user:pass@cluster0.example.mongodb.net/LibreChat?appName=Cluster0',
    );
    expect(args.conversations).toBe(false);
  });

  test('resolveSelections respects --all', () => {
    const { selections, hasSelection } = resolveSelections({ all: true });
    expect(hasSelection).toBe(true);
    expect(selections).toEqual({
      memories: true,
      conversations: true,
      settings: true,
      agents: true,
      prompts: true,
    });
  });

  test('resolveSelections detects no selection', () => {
    const { hasSelection } = resolveSelections({});
    expect(hasSelection).toBe(false);
  });

  test('sanitizeEmailForPath normalizes safely', () => {
    expect(sanitizeEmailForPath('User+Test@Example.com')).toBe('user_test_example.com');
  });

  test('DEFAULT_BASE_DIR is defined', () => {
    expect(DEFAULT_BASE_DIR).toBeTruthy();
  });

  test('buildOwnerGrantRequests dedupes resource ids', () => {
    const requests = buildOwnerGrantRequests({
      resourceType: 'agent',
      accessRoleId: 'AGENT_OWNER',
      principalId: 'user1',
      grantedBy: 'user1',
      resourceIds: ['a', 'a', 'b'],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      principalId: 'user1',
      resourceType: 'agent',
      accessRoleId: 'AGENT_OWNER',
      grantedBy: 'user1',
    });
  });
});
