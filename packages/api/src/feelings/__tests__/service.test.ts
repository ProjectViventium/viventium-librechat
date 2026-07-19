import {
  applyFeelingOperations,
  clearFeelingsReadCache,
  createInitialFeelingState,
  loadFeelingsReadContext,
  parseFeelingReactionOutput,
  prepareManualFeelingPatch,
} from '../service';

describe('Feelings state service', () => {
  beforeEach(() => clearFeelingsReadCache());

  it('returns a complete default-off snapshot without creating a database row', async () => {
    const getFeelingState = jest.fn().mockResolvedValue(null);
    const snapshot = await loadFeelingsReadContext({
      userId: 'synthetic-user',
      getFeelingState,
      now: new Date('2026-07-09T12:00:00.000Z'),
      env: {},
      bypassCache: true,
    });

    expect(getFeelingState).toHaveBeenCalledWith('synthetic-user');
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.capsule).toBe('');
    expect(snapshot.version).toBe(0);
    expect(snapshot.innerState).toBeNull();
    expect(snapshot.reactionActivationMode).toBe('always');
    expect(snapshot.reactionInstruction).toContain('React to what genuinely moves Viventium');
    expect(snapshot.reactionInstruction).toContain('match how much the moment matters');
    expect(snapshot.reactionInstruction).not.toContain('Prefer small natural changes');
  });

  it('upgrades the exact previously shipped reaction default without replacing user instructions', async () => {
    const legacyDefault =
      'React to what genuinely moves Viventium. Prefer small natural changes. Move only the feelings the moment actually touches, and leave nature unchanged.';
    const legacySnapshot = await loadFeelingsReadContext({
      userId: 'legacy-default-user',
      getFeelingState: jest.fn().mockResolvedValue({ reactionInstruction: legacyDefault }),
      env: {},
      bypassCache: true,
    });
    expect(legacySnapshot.reactionInstruction).toContain('match how much the moment matters');
    expect(legacySnapshot.reactionInstruction).not.toContain('Prefer small natural changes');

    const customInstruction = 'React rarely, but follow the actual meaning of the moment.';
    const customSnapshot = await loadFeelingsReadContext({
      userId: 'custom-instruction-user',
      getFeelingState: jest.fn().mockResolvedValue({ reactionInstruction: customInstruction }),
      env: {},
      bypassCache: true,
    });
    expect(customSnapshot.reactionInstruction).toBe(customInstruction);
  });

  it('caches reads briefly and clears the user entry after writes', async () => {
    const getFeelingState = jest.fn().mockResolvedValue(null);
    const args = { userId: 'synthetic-user', getFeelingState, env: {} };
    await loadFeelingsReadContext(args);
    const cached = await loadFeelingsReadContext(args);
    expect(getFeelingState).toHaveBeenCalledTimes(1);
    expect(cached.cacheHit).toBe(true);
    clearFeelingsReadCache('synthetic-user');
    await loadFeelingsReadContext(args);
    expect(getFeelingState).toHaveBeenCalledTimes(2);
  });

  it('materializes elapsed decay even when the feature and band are disabled', async () => {
    const getFeelingState = jest.fn().mockResolvedValue({
      enabled: false,
      version: 4,
      reactionActivationMode: 'disabled',
      bands: {
        vigilance: {
          baseline: 68,
          current: 100,
          halfLifeMinutes: 20,
          enabled: false,
          updatedAt: new Date('2026-07-09T11:40:00.000Z'),
        },
      },
      trail: [],
      reactionHealth: { status: 'skipped' },
    });
    const snapshot = await loadFeelingsReadContext({
      userId: 'synthetic-user',
      getFeelingState,
      now: new Date('2026-07-09T12:00:00.000Z'),
      env: {},
      bypassCache: true,
    });

    expect(snapshot.bands.vigilance.current).toBeCloseTo(84, 8);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.capsule).toBe('');
  });

  it('creates a persisted initial state from operator defaults', () => {
    const initial = createInitialFeelingState({
      now: new Date('2026-07-09T12:00:00.000Z'),
      env: { VIVENTIUM_FEELINGS_DEFAULT_ENABLED: 'true' },
    });
    expect(initial.enabled).toBe(true);
    expect(initial.version).toBe(0);
    expect(initial.bands.care.baseline).toBe(74);
    expect(initial.trail).toEqual([]);
  });

  it('parses only typed reaction operations from fenced or plain JSON', () => {
    expect(
      parseFeelingReactionOutput(
        '```json\n{"changes":[{"band":"vigilance","direction":"up","strength":"clear","cause":"uncertainty"}],"innerState":"I feel alert, grounded, and ready to look more closely."}\n```',
      ),
    ).toEqual({
      changes: [{ band: 'vigilance', direction: 'up', strength: 'clear', cause: 'uncertainty' }],
      innerState: 'I feel alert, grounded, and ready to look more closely.',
    });
    expect(() =>
      parseFeelingReactionOutput(
        '{"changes":[{"band":"unknown","direction":"up","strength":"strong","cause":"other"}],"innerState":"I feel changed."}',
      ),
    ).toThrow('Invalid Emotional Reaction output');
    expect(() => parseFeelingReactionOutput('not json')).toThrow(
      'Invalid Emotional Reaction output',
    );
    expect(() =>
      parseFeelingReactionOutput(
        '{"changes":[{"band":"play","direction":"up","strength":"clear"}],"innerState":"I feel lighter."}',
      ),
    ).toThrow('Invalid Emotional Reaction output');
    expect(() =>
      parseFeelingReactionOutput(
        '{"changes":[{"band":"play","direction":"up","strength":"clear","cause":"raw private explanation"}],"innerState":"I feel lighter."}',
      ),
    ).toThrow('Invalid Emotional Reaction output');
    for (const internalCause of ['manual_adjustment', 'reset_to_nature']) {
      expect(() =>
        parseFeelingReactionOutput(
          JSON.stringify({
            changes: [{ band: 'play', direction: 'up', strength: 'clear', cause: internalCause }],
            innerState: 'I feel lighter.',
          }),
        ),
      ).toThrow('Invalid Emotional Reaction output');
    }
    expect(() =>
      parseFeelingReactionOutput(
        '{"changes":[{"band":"energy","direction":"up","strength":"slight","cause":"progress"},{"band":"energy","direction":"down","strength":"clear","cause":"fatigue"}],"innerState":"I feel pulled in two directions."}',
      ),
    ).toThrow('Invalid Emotional Reaction output');
    expect(() => parseFeelingReactionOutput('{"changes":[],"innerState":""}')).toThrow(
      'Invalid Emotional Reaction output',
    );
    expect(() =>
      parseFeelingReactionOutput('{"changes":[],"innerState":"first line\\nsecond line"}'),
    ).toThrow('Invalid Emotional Reaction output');
    expect(() =>
      parseFeelingReactionOutput(JSON.stringify({ changes: [], innerState: 'x'.repeat(281) })),
    ).toThrow('Invalid Emotional Reaction output');
    expect(() => parseFeelingReactionOutput('{"changes":[]}')).toThrow(
      'Invalid Emotional Reaction output',
    );
  });

  it('merges Mood and Openness into a legacy seven-band stored state', async () => {
    const initial = createInitialFeelingState({ now: new Date('2026-07-09T12:00:00.000Z') });
    const { mood: _mood, openness: _openness, ...legacyBands } = initial.bands;
    const snapshot = await loadFeelingsReadContext({
      userId: 'legacy-user',
      getFeelingState: jest.fn().mockResolvedValue({
        enabled: true,
        version: 7,
        bands: legacyBands,
        trail: [],
      }),
      now: new Date('2026-07-09T12:05:00.000Z'),
      env: {},
      bypassCache: true,
    });

    expect(snapshot.bands.mood).toEqual(expect.objectContaining({ baseline: 58, current: 58 }));
    expect(snapshot.bands.openness).toEqual(expect.objectContaining({ baseline: 55, current: 55 }));
    expect(snapshot.capsule).toContain('mood:');
    expect(snapshot.capsule).toContain('openness:');
  });

  it('maps typed strengths to bounded deltas and ignores disabled bands', () => {
    const initial = createInitialFeelingState({ now: new Date('2026-07-09T12:00:00.000Z') });
    initial.bands.play.current = 98;
    initial.bands.care.enabled = false;
    const applied = applyFeelingOperations({
      bands: initial.bands,
      changes: [
        { band: 'play', direction: 'up', strength: 'strong', cause: 'playful_exchange' },
        { band: 'vigilance', direction: 'down', strength: 'slight', cause: 'progress' },
        { band: 'care', direction: 'up', strength: 'strong', cause: 'care_signal' },
      ],
      now: new Date('2026-07-09T12:01:00.000Z'),
    });

    expect(applied.bands.play.current).toBe(100);
    expect(applied.bands.vigilance.current).toBe(65);
    expect(applied.bands.care.current).toBe(74);
    expect(applied.trail).toHaveLength(2);
  });

  it('prepares independent manual Current, Nature, half-life, enable, and reset patches', () => {
    const initial = createInitialFeelingState({ now: new Date('2026-07-09T12:00:00.000Z') });
    initial.bands.energy.current = 80;
    const nature = prepareManualFeelingPatch({
      bands: initial.bands,
      bandId: 'energy',
      change: { baseline: 40 },
      now: new Date('2026-07-09T12:00:00.000Z'),
    });
    expect(nature.band.baseline).toBe(40);
    expect(nature.band.current).toBe(80);

    const current = prepareManualFeelingPatch({
      bands: initial.bands,
      bandId: 'energy',
      change: { current: 25 },
      now: new Date('2026-07-09T12:00:00.000Z'),
    });
    expect(current.band.current).toBe(25);
    expect(current.band.baseline).toBe(56);
    expect(current.trail).toHaveLength(1);

    const reset = prepareManualFeelingPatch({
      bands: initial.bands,
      bandId: 'energy',
      change: { reset: true },
      now: new Date('2026-07-09T12:00:00.000Z'),
    });
    expect(reset.band.current).toBe(56);
  });
});
