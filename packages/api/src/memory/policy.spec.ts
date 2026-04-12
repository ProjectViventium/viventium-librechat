import {
  compactWorldValue,
  createMemoryMaintenancePlan,
  DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
  evaluateMemoryWrite,
  prepareMemoryValueForWrite,
} from './policy';

jest.mock('~/utils', () => ({
  Tokenizer: {
    getTokenCount: jest.fn((text: string) => text.length),
  },
}));

describe('memory policy', () => {
  describe('prepareMemoryValueForWrite', () => {
    it('collapses repeated semicolon corruption before storing structured memory', () => {
      const prepared = prepareMemoryValueForWrite({
        key: 'context',
        value: [
          'Priority tracks:',
          '- Track1 Work: Release prep;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;; blocked on review',
          '_updated: 2026-03-08',
        ].join('\n'),
      });

      expect(prepared.value).toContain('Release prep; blocked on review');
      expect(prepared.value).not.toContain(';;;;;;;;;;;;;;;;');
    });

    it('preserves intentional single semicolon separators', () => {
      const prepared = prepareMemoryValueForWrite({
        key: 'context',
        value: [
          'Priority tracks:',
          '- Track1 Work: Release prep; blocked on review',
          '_updated: 2026-03-08',
        ].join('\n'),
      });

      expect(prepared.value).toContain('Release prep; blocked on review');
      expect(prepared.value).not.toContain('Release prep  blocked on review');
    });

    it('cleans repeated semicolon corruption in draft summaries before storing', () => {
      const prepared = prepareMemoryValueForWrite({
        key: 'drafts',
        value: [
          '- thread: partner_followup | status: in_progress | last_worked: 2026-03-08',
          '  summary: "Partner follow-up;;;;;;;;;;;;;;;; blocked on response."',
          '  next: Send concise update.',
        ].join('\n'),
      });

      expect(prepared.value).toContain('summary: "Partner follow-up; blocked on response."');
      expect(prepared.value).not.toContain(';;;;;;;;;;;;;;;;');
    });
  });

  describe('evaluateMemoryWrite', () => {
    it('rejects scheduler and tool operational residue', () => {
      const result = evaluateMemoryWrite({
        key: 'me',
        value: 'Wake loop {NTA} with tool auth errors',
        tokenCount: 40,
      });

      expect(result.ok).toBe(false);
      expect(result.errorType).toBe('noise_rejected');
    });

    it('rejects writes that would exceed a per-key budget but allows self-healing overwrites', () => {
      const rejected = evaluateMemoryWrite({
        key: 'drafts',
        value: '01234567890',
        tokenCount: 11,
        keyLimits: { drafts: 10 },
        baselineTotalTokens: 11,
        previousTokenCount: 0,
      });

      expect(rejected.ok).toBe(false);
      expect(rejected.errorType).toBe('key_limit_exceeded');

      const allowed = evaluateMemoryWrite({
        key: 'drafts',
        value: '012345678',
        tokenCount: 9,
        keyLimits: { drafts: 10 },
        baselineTotalTokens: 18,
        previousTokenCount: 18,
      });

      expect(allowed.ok).toBe(true);
    });
  });

  describe('world compaction', () => {
    it('pre-compacts world writes before they hit the hard cap', () => {
      const prepared = prepareMemoryValueForWrite({
        key: 'world',
        value: [
          'Partner: Sam. Met May 25 2022. Recently requested a birthday gift.',
          'Ventures:',
          '- Project Atlas: Decision intelligence for regulated enterprises. prod live. pending DNS/Gemini. Alex call Thu 3PM ET.',
          'Key people: Morgan (co-founder), Robin (CEO, Thu 3PM), Taylor (outreach stalled)',
        ].join('\n'),
        keyLimits: { world: 120 },
      });

      expect(prepared.compacted).toBe(true);
      expect(prepared.value).toContain('Met May 25 2022');
      expect(prepared.value).toContain('Decision intelligence for regulated enterprises');
      expect(prepared.value).not.toContain('birthday gift');
      expect(prepared.value).not.toContain('pending DNS');
      expect(prepared.value).not.toContain('Thu 3PM');
      expect(prepared.value).not.toContain('@');
      expect(prepared.tokenCount).toBeLessThanOrEqual(120);
    });

    it('compacts near-budget world memory during maintenance', () => {
      const original = [
        'Partner: Sam. Met May 25 2022. Recently requested a birthday gift.',
        'Ventures:',
        '- Project Atlas: Decision intelligence for regulated enterprises. prod live. pending DNS/Gemini.',
        'Key people: Morgan (co-founder), Taylor (outreach stalled)',
        '_updated: 2026-03-18',
      ].join('\n');

      const plan = createMemoryMaintenancePlan({
        memories: [
          {
            key: 'world',
            tokenCount: 1100,
            value: original,
          },
        ],
        policy: {
          tokenLimit: 8000,
          keyLimits: DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
          maintenanceThresholdPercent: 80,
        },
        now: new Date('2026-03-24T17:30:00.000Z'),
      });

      expect(plan.shouldApply).toBe(true);
      const worldUpdate = plan.updates.find((update) => update.key === 'world');
      expect(worldUpdate?.reason).toBe(
        'Compacted world to durable relationships and venture identity',
      );
      expect(worldUpdate?.value).toContain('Met May 25 2022');
      expect(worldUpdate?.value).not.toContain('birthday gift');
      expect(worldUpdate?.value).not.toContain('pending DNS');
      expect(worldUpdate?.value).not.toContain('@');
    });

    it('keeps durable formation context when compacting world', () => {
      const compacted = compactWorldValue(
        [
          'Partner: Sam. Met May 25 2022 (first date: AI singularity). Married Dec 2025 Cancun. Recently requested a birthday gift.',
          '_updated: 2026-03-18',
        ].join('\n'),
        new Date('2026-03-24T00:00:00.000Z'),
        200,
      );

      expect(compacted).toContain('Met May 25 2022');
      expect(compacted).toContain('Married Dec 2025 Cancun');
      expect(compacted).not.toContain('birthday gift');
    });
  });

  describe('createMemoryMaintenancePlan', () => {
    it('compacts contaminated memories deterministically', () => {
      const plan = createMemoryMaintenancePlan({
        memories: [
          {
            key: 'me',
            tokenCount: 120,
            value: [
              "What I've noticed:",
              '- Overwhelmed: one clear next > options.',
              '- Wake loops 20x+ {NTA} with tool auth errors.',
              '',
              'What works:',
              '- Short/direct.',
            ].join('\n'),
          },
          {
            key: 'signals',
            tokenCount: 180,
            value: [
              '- domain: wake_loop_testing',
              '  observation: "Repeated Wake commands with {NTA} and tool auth errors"',
              '  confidence: high | first_seen: 2026-03-08 | last_seen: 2026-03-08',
              '  evidence:',
              '    - "Wake loop 1"',
              '',
              '- domain: business_execution',
              '  observation: "Strong on product and strategy, slower on people-heavy sales"',
              '  confidence: high | first_seen: 2026-01-22 | last_seen: 2026-03-05',
              '  evidence:',
              '    - "Priority release ready"',
              '    - "Platform milestone locked"',
              '_updated: 2026-03-08',
            ].join('\n'),
          },
          {
            key: 'drafts',
            tokenCount: 420,
            value: [
              '- thread: scheduling_cortex',
              '  status: done | started: 2026-02-09 | last_worked: 2026-03-01',
              '  direction: "Regional monitor discontinued 03-01 after repeated quiet-state wake loops."',
              '  next: None.',
              '',
              '- thread: viventium_projects_feature',
              '  status: in_progress | started: 2026-03-07 | last_worked: 2026-03-09',
              '  direction: "Workers and projects feature with project.md, persistent VM, MCP sync, scoped chat, e2b SDK test, and priorities for inbox/calendar/drive/perms."',
              '  next: Spec details, run init test, estimate hours, list missing capabilities.',
              '_updated: 2026-03-09',
            ].join('\n'),
          },
          {
            key: 'context',
            tokenCount: 260,
            value: [
              'Priority tracks:',
              '- Track1 Money: Large planning block with repeated checks 26x+ and no new data.',
              'Open loops: repeated checks, no new data, SF housing, Viventium',
              '_updated: 2026-03-09',
              '_expires: 2026-03-16',
            ].join('\n'),
          },
          {
            key: 'working',
            tokenCount: 94,
            value: [
              'NOW (2026-03-09 Mon 11:44AM Toronto): Workspace. Repeated internal checks (DNS review, release announcement, OAuth tests) x7+ all {NTA} no new data.',
              '_updated: 2026-03-09 | _stale_after: 2026-03-10 | _expires: 2026-03-12',
            ].join('\n'),
          },
        ],
        policy: {
          tokenLimit: 800,
          keyLimits: DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
          maintenanceThresholdPercent: 80,
        },
        now: new Date('2026-03-09T16:00:00.000Z'),
      });

      expect(plan.shouldApply).toBe(true);
      expect(plan.totalTokensAfter).toBeLessThan(plan.totalTokensBefore);

      const meUpdate = plan.updates.find((update) => update.key === 'me');
      expect(meUpdate?.value).not.toContain('{NTA}');

      const signalsUpdate = plan.updates.find((update) => update.key === 'signals');
      expect(signalsUpdate?.value).not.toContain('wake_loop_testing');
      expect(signalsUpdate?.value).toContain('business_execution');

      const draftsUpdate = plan.updates.find((update) => update.key === 'drafts');
      expect(draftsUpdate?.value).toContain('summary:');
      expect(draftsUpdate?.value).toContain('Archived:');
      expect(draftsUpdate?.value).not.toContain('repeated quiet-state wake loops');

      const contextUpdate = plan.updates.find((update) => update.key === 'context');
      expect(contextUpdate?.value).not.toContain('repeated checks 26x+');

      const workingUpdate = plan.updates.find((update) => update.key === 'working');
      expect(workingUpdate?.value).toContain('Workspace');
      expect(workingUpdate?.value).not.toContain('{NTA}');
      expect(workingUpdate?.value).not.toContain('Internal Checks');
      expect(workingUpdate?.value).not.toContain('no new data');
    });

    it('refreshes expired context and working snapshots even without token pressure', () => {
      const plan = createMemoryMaintenancePlan({
        memories: [
          {
            key: 'context',
            tokenCount: 140,
            value: [
              'Priority tracks:',
              '- Track1 Work: Release prep blocked on final review.',
              '_updated: 2026-03-01',
              '_expires: 2026-03-08',
            ].join('\n'),
          },
          {
            key: 'working',
            tokenCount: 96,
            value: [
              'At desk preparing release notes.',
              '_updated: 2026-03-01 | _stale_after: 2026-03-02 | _expires: 2026-03-04',
            ].join('\n'),
          },
        ],
        policy: {
          tokenLimit: 8000,
          keyLimits: DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
          maintenanceThresholdPercent: 80,
        },
        now: new Date('2026-03-09T16:00:00.000Z'),
      });

      expect(plan.shouldApply).toBe(true);
      expect(plan.reason).toContain('context expired and needs refresh');
      expect(plan.reason).toContain('working snapshot is stale or expired');

      const contextUpdate = plan.updates.find((update) => update.key === 'context');
      expect(contextUpdate?.value).toContain('_updated: 2026-03-09');
      expect(contextUpdate?.value).toContain('_expires: 2026-03-16');

      const workingUpdate = plan.updates.find((update) => update.key === 'working');
      expect(workingUpdate?.value).toContain(
        '_updated: 2026-03-09 | _stale_after: 2026-03-10 | _expires: 2026-03-12',
      );
    });

    it('treats repeated separator corruption as a maintenance trigger even without other pressure', () => {
      const plan = createMemoryMaintenancePlan({
        memories: [
          {
            key: 'me',
            tokenCount: 160,
            value: [
              "What I've noticed:",
              '- Stable when the next step is obvious;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;; concise wins',
              '_updated: 2026-03-09',
            ].join('\n'),
          },
        ],
        policy: {
          tokenLimit: 8000,
          keyLimits: DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
          maintenanceThresholdPercent: 80,
        },
        now: new Date('2026-03-09T16:00:00.000Z'),
      });

      expect(plan.shouldApply).toBe(true);
      expect(plan.reason).toContain('existing memories contain repeated separator corruption');

      const meUpdate = plan.updates.find((update) => update.key === 'me');
      expect(meUpdate?.value).toContain('obvious; concise wins');
      expect(meUpdate?.value).not.toContain(';;;;;;;;;;;;;;;;');
    });

    it('archives long-idle active drafts and preserves archived history', () => {
      const plan = createMemoryMaintenancePlan({
        memories: [
          {
            key: 'drafts',
            tokenCount: 320,
            value: [
              '- thread: stale_partner_followup | status: in_progress | last_worked: 2026-03-01',
              '  summary: "Partner follow-up;;;;;;;;;;;;;;;;;;;;;;;; blocked on response."',
              '  next: Send concise update.',
              '',
              'Archived:',
              '- shipped_launch_note | done | last_worked: 2026-02-20 | shipped_launch_note: Sent launch note and closed thread',
              '_updated: 2026-03-02',
            ].join('\n'),
          },
        ],
        policy: {
          tokenLimit: 8000,
          keyLimits: DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS,
          maintenanceThresholdPercent: 80,
        },
        now: new Date('2026-03-20T16:00:00.000Z'),
      });

      expect(plan.shouldApply).toBe(true);
      expect(plan.reason).toContain('drafts contain long-idle active work');

      const draftsUpdate = plan.updates.find((update) => update.key === 'drafts');
      expect(draftsUpdate?.value).toContain('Archived:');
      expect(draftsUpdate?.value).toContain('shipped_launch_note | done');
      expect(draftsUpdate?.value).toContain('stale_partner_followup | in_progress');
      expect(draftsUpdate?.value).not.toContain('- thread: stale_partner_followup');
      expect(draftsUpdate?.value).not.toContain(';;;;;;;;;;;;;;;;');
    });
  });
});
