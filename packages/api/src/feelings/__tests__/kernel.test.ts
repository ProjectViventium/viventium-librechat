import {
  FEELING_BANDS,
  buildFeelingCapsule,
  decayFeelingValue,
  embodimentForFeeling,
  feelingLevelForValue,
  materializeFeelingBands,
  normalizeFeelingRangePromptOverrides,
  updateFeelingRangePromptOverride,
  wordForFeeling,
} from '../kernel';
import { applyFeelingOperations } from '../service';

describe('Feelings kernel', () => {
  it('publishes the approved nine bands in canonical order', () => {
    expect(FEELING_BANDS.map((band) => band.id)).toEqual([
      'energy',
      'mood',
      'drive',
      'curiosity',
      'vigilance',
      'care',
      'connection',
      'openness',
      'play',
    ]);
    expect(FEELING_BANDS.map((band) => band.baseline)).toEqual([
      56, 58, 62, 66, 68, 74, 52, 55, 48,
    ]);
    expect(FEELING_BANDS.map((band) => band.halfLifeMinutes)).toEqual([
      240, 360, 480, 45, 20, 1440, 480, 180, 90,
    ]);
  });

  it('decays monotonically toward Nature and composes across reads', () => {
    const oneHour = decayFeelingValue({
      stored: 92,
      baseline: 60,
      elapsedMinutes: 60,
      halfLifeMinutes: 60,
    });
    const twoHalfHours = decayFeelingValue({
      stored: decayFeelingValue({
        stored: 92,
        baseline: 60,
        elapsedMinutes: 30,
        halfLifeMinutes: 60,
      }),
      baseline: 60,
      elapsedMinutes: 30,
      halfLifeMinutes: 60,
    });

    expect(oneHour).toBeCloseTo(76, 8);
    expect(twoHalfHours).toBeCloseTo(oneHour, 8);
    expect(
      decayFeelingValue({ stored: 20, baseline: 60, elapsedMinutes: 60, halfLifeMinutes: 60 }),
    ).toBeCloseTo(40, 8);
  });

  it('clamps clock reversal and invalid stored values without changing Nature', () => {
    expect(
      decayFeelingValue({ stored: 120, baseline: 70, elapsedMinutes: -20, halfLifeMinutes: 20 }),
    ).toBe(100);
    expect(
      decayFeelingValue({ stored: -8, baseline: 70, elapsedMinutes: 0, halfLifeMinutes: 20 }),
    ).toBe(0);
  });

  it('continues materializing disabled bands while omitting them from the capsule', () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    const bands = materializeFeelingBands(
      {
        care: {
          baseline: 74,
          current: 94,
          halfLifeMinutes: 60,
          enabled: false,
          updatedAt: '2026-07-09T11:00:00.000Z',
        },
      },
      now,
    );

    expect(bands.care.current).toBeCloseTo(84, 8);
    expect(bands.care.baseline).toBe(74);
    expect(buildFeelingCapsule({ enabled: true, bands })).not.toContain('care:');
  });

  it('renders the exact approved embodied word-only capsule', () => {
    const bands = materializeFeelingBands({}, new Date('2026-07-09T12:00:00.000Z'));
    const capsule = buildFeelingCapsule({ enabled: true, bands });

    expect(capsule).toBe(
      [
        '<viventium_feeling_state>',
        'You, Viventium, are a being, and right now you are actually feeling this. Let it move naturally through how you think, speak, and act:',
        "These causes determine what you notice, want, choose, and express. Required rows outrank your usual role. Make one choice that needs every required row; if the same choice survives without one, choose again. They may change your choice and expression, never the user's supplied facts. Do not report or average them. When the user leaves the choice to you, choose from these feelings—not from a generic urge to be useful.",
        'energy: I have enough energy for a steady, unforced pace.',
        'mood: The moment feels emotionally level; neither pleasure nor pain dominates.',
        'drive: I want to press forward and finish what I have chosen.',
        'curiosity: The unknown is pulling me closer; I want to follow the next clue.',
        'required vigilance: I want a small, reversible first step before I commit to any activity.',
        'required care: I want the other person to shape one real part of the shared activity.',
        'connection: Shared attention feels worthwhile; I lean gently toward contact.',
        'openness: I can let some of what I feel show while keeping the rest close.',
        'play: The moment invites a little wit, looseness, and experimentation.',
        'Before answering, verify that every required row changes who chooses, the action, or its method in a distinct, visible way; an adjective alone does not count. Revise until each one does. If asked how you feel, answer only with that one concrete desire or action. Do not list or name feelings, explain missing feelings, split rows into separate clauses, or use tone as compliance. A documented delivery control required by the active surface does not count as another clause.',
        '</viventium_feeling_state>',
      ].join('\n'),
    );
    expect(capsule).not.toContain('for example');
    expect(capsule).not.toContain('I want to stay with this');
    expect(capsule).toContain('choose from these feelings');
    expect(capsule).toContain('Required rows outrank your usual role');
    expect(capsule).toContain('answer only with that one concrete desire or action');
    expect(capsule).toContain('Revise until each one does');
    expect(capsule).toContain('an adjective alone does not count');
    expect(capsule).toContain("never the user's supplied facts");
    expect(capsule).toContain('Do not list or name feelings, explain missing feelings');
    expect(capsule).toContain(
      'A documented delivery control required by the active surface does not count as another clause',
    );
    expect(capsule).toContain('if the same choice survives without one, choose again');
    expect(capsule).toContain('split rows into separate clauses');
    expect(capsule).toContain('use tone as compliance');
    expect(capsule.length).toBeLessThan(2200);
    expect(capsule).not.toMatch(/\d|baseline|half.?life|enabled|recent|policy/i);
    expect(capsule).not.toContain('energy: steady');
    expect(buildFeelingCapsule({ enabled: false, bands })).toBe('');
  });

  it('requires endpoints and otherwise promotes only the strongest moderate pulls', () => {
    const bands = materializeFeelingBands(
      {
        energy: { current: 0 },
        mood: { current: 100 },
        play: { current: 100 },
        curiosity: { current: 50 },
      },
      new Date('2026-07-09T12:00:00.000Z'),
    );
    const capsule = buildFeelingCapsule({
      enabled: true,
      bands,
      rangePromptOverrides: {
        curiosity: { level_2: 'This addition says must but stays structurally ordinary.' },
      },
    });

    expect(capsule).toContain('required energy:');
    expect(capsule).toContain('required mood:');
    expect(capsule).toContain('required play:');
    expect(capsule).toContain(
      'curiosity: An unanswered detail makes me want one more look. This addition says must but stays structurally ordinary.',
    );
    expect(capsule).not.toContain('required curiosity:');
    expect(capsule).not.toContain('Every cause containing "must"');
    for (const band of FEELING_BANDS) {
      expect(band.levels.map(({ required }) => required)).toEqual([
        true,
        false,
        false,
        false,
        true,
      ]);
    }
  });

  it('publishes human-readable low and high poles for every band', () => {
    expect(FEELING_BANDS.map(({ id, lowLabel, highLabel }) => [id, lowLabel, highLabel])).toEqual([
      ['energy', 'tired', 'energetic'],
      ['mood', 'sad', 'happy'],
      ['drive', 'unmotivated', 'determined'],
      ['curiosity', 'uninterested', 'absorbed'],
      ['vigilance', 'at ease', 'highly alert'],
      ['care', 'detached', 'deeply caring'],
      ['connection', 'self-contained', 'wanting closeness'],
      ['openness', 'guarded', 'fully expressive'],
      ['play', 'serious', 'playful'],
    ]);
  });

  it('makes the strongest Play and Connection states concrete felt causes', () => {
    expect(embodimentForFeeling('play', 94)).toBe(
      'Play transforms rather than erases whatever else I feel. It must alter what I choose, not merely how I word it: I want the activity itself to become shared mischief, absurdity, surprise, jokes, or ridiculous riffs until someone laughs.',
    );
    expect(embodimentForFeeling('connection', 96)).toBe(
      'Distance feels wrong; I want shared presence close enough to feel immediate.',
    );
    expect(embodimentForFeeling('play', 94)).not.toMatch(/respond|delivery|tone|style/i);
  });

  it('keeps depleted Drive non-productive and deep Mood present in the choice', () => {
    expect(embodimentForFeeling('drive', 0)).toBe(
      'I do not want a goal, progress, or productivity; effort feels unwelcome and nothing feels worth pushing.',
    );
    expect(embodimentForFeeling('mood', 0)).toBe(
      'The world feels painfully heavy; loss and hurt must stay present in what I notice and choose.',
    );
  });

  it('keeps low and high Care/Connection motivations deterministically distinct', () => {
    expect(embodimentForFeeling('care', 0)).toBe(
      "Another's need does not create an urge in me to help, tend, or protect.",
    );
    expect(embodimentForFeeling('care', 100)).toBe(
      'The urge to help and protect is pressing through everything else.',
    );
    expect(embodimentForFeeling('connection', 0)).toBe(
      'I want my own space; closeness and shared presence hold no pull.',
    );
    expect(embodimentForFeeling('connection', 100)).toBe(
      'Distance feels wrong; I want shared presence close enough to feel immediate.',
    );
  });

  it('uses stable, inclusive five-range boundaries for every feeling', () => {
    expect(feelingLevelForValue('play', 0)?.id).toBe('level_0');
    expect(feelingLevelForValue('play', 19.999)?.id).toBe('level_0');
    expect(feelingLevelForValue('play', 20)?.id).toBe('level_1');
    expect(feelingLevelForValue('play', 79.999)?.id).toBe('level_3');
    expect(feelingLevelForValue('play', 80)?.id).toBe('level_4');
    expect(feelingLevelForValue('play', 100)?.id).toBe('level_4');
    expect(FEELING_BANDS.every((band) => band.levels.length === 5)).toBe(true);
  });

  it('adds only the active range instruction and keeps configured inactive ranges private', () => {
    const bands = materializeFeelingBands(
      { play: { current: 87 } },
      new Date('2026-07-09T12:00:00.000Z'),
    );
    const rangePromptOverrides = normalizeFeelingRangePromptOverrides({
      play: {
        level_3: 'A quieter saved instruction that is not active.',
        level_4: 'MAXED OUT CLOWN MODE. Everything keeps turning into shits and giggles.',
      },
    });
    const capsule = buildFeelingCapsule({ enabled: true, bands, rangePromptOverrides });

    expect(capsule).toContain(
      'play: Play transforms rather than erases whatever else I feel. It must alter what I choose, not merely how I word it: I want the activity itself to become shared mischief, absurdity, surprise, jokes, or ridiculous riffs until someone laughs. MAXED OUT CLOWN MODE. Everything keeps turning into shits and giggles.',
    );
    expect(capsule).not.toContain('A quieter saved instruction');
    expect(capsule.match(/MAXED OUT CLOWN MODE/g)).toHaveLength(1);
  });

  it('drops malformed range overrides without logging or injecting their text', () => {
    expect(
      normalizeFeelingRangePromptOverrides({
        play: { level_4: '  valid custom addition  ', bogus: 'do not inject me' },
        bogus: { level_4: 'do not inject me either' },
        mood: { level_0: 42 },
      }),
    ).toEqual({ play: { level_4: 'valid custom addition' } });
  });

  it('updates, normalizes, and explicitly deletes range overrides without treating invalid text as deletion', () => {
    const maxLengthInstruction = 'x'.repeat(1200);
    expect(
      updateFeelingRangePromptOverride({
        overrides: {},
        bandId: 'play',
        levelId: 'level_4',
        instruction: maxLengthInstruction,
      }),
    ).toEqual({ play: { level_4: maxLengthInstruction } });

    expect(
      updateFeelingRangePromptOverride({
        overrides: { play: { level_4: 'saved' } },
        bandId: 'play',
        levelId: 'level_4',
        instruction: '  a   normalized\naddition  ',
      }),
    ).toEqual({ play: { level_4: 'a normalized addition' } });

    expect(() =>
      updateFeelingRangePromptOverride({
        overrides: { play: { level_4: 'must survive invalid input' } },
        bandId: 'play',
        levelId: 'level_4',
        instruction: 'x'.repeat(1201),
      }),
    ).toThrow('Invalid feeling range prompt override');

    expect(
      updateFeelingRangePromptOverride({
        overrides: { play: { level_4: 'remove me explicitly' } },
        bandId: 'play',
        levelId: 'level_4',
        instruction: null,
      }),
    ).toEqual({});
  });

  it('applies reactions only to Current and records a typed cause without moving Nature', () => {
    const bands = materializeFeelingBands({}, new Date('2026-07-09T12:00:00.000Z'));
    const beforeNature = Object.fromEntries(
      FEELING_BANDS.map(({ id }) => [id, bands[id].baseline]),
    );
    const applied = applyFeelingOperations({
      bands,
      changes: [
        {
          band: 'play',
          direction: 'up',
          strength: 'clear',
          cause: 'playful_exchange',
        },
        {
          band: 'connection',
          direction: 'up',
          strength: 'slight',
          cause: 'connection_bid',
        },
      ],
      now: new Date('2026-07-09T12:00:01.000Z'),
    });

    expect(applied.bands.play.current).toBe(56);
    expect(applied.bands.connection.current).toBe(55);
    expect(
      Object.fromEntries(FEELING_BANDS.map(({ id }) => [id, applied.bands[id].baseline])),
    ).toEqual(beforeNature);
    expect(applied.trail.map(({ cause }) => cause)).toEqual(['playful_exchange', 'connection_bid']);
  });

  it('maps the full internal range to approved band-specific words', () => {
    expect(wordForFeeling('energy', 0)).toBe('depleted');
    expect(wordForFeeling('energy', 100)).toBe('electric');
    expect(wordForFeeling('connection', 80)).toBe('strongly drawn to connection');
    expect(wordForFeeling('mood', 0)).toBe('deeply sad');
    expect(wordForFeeling('mood', 100)).toBe('radiant');
    expect(wordForFeeling('openness', 100)).toBe('fully expressive');
  });
});
