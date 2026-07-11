import {
  FEELING_BANDS,
  buildFeelingCapsule,
  decayFeelingValue,
  embodimentForFeeling,
  materializeFeelingBands,
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
        'These lines are private causes, not answer content. Live them: translate them into choices and expression rather than reporting them. If asked how you feel, answer with one lived first-person sentence that begins with the desire, concern, attention, image, impulse, or action they create—for example: “I want to stay with this and follow what remains unresolved.” Begin there, with no mood or state preface or summary. Let the causes shape what you notice, prioritize, choose, and express.',
        'energy: I can sustain an even pace',
        'mood: I feel quietly okay within myself',
        'drive: I keep pressing toward chosen goals',
        'curiosity: I want to follow what is not yet known',
        'vigilance: uncertainty pulls me to verify before acting',
        'care: I want to tend, help, and protect',
        'connection: I lean toward shared attention',
        'openness: I reveal what I feel with some restraint',
        'play: I look for a lighter, more flexible move',
        '</viventium_feeling_state>',
      ].join('\n'),
    );
    expect(capsule).not.toMatch(/\d|baseline|half.?life|enabled|recent|policy/i);
    expect(capsule).not.toContain('energy: steady');
    expect(buildFeelingCapsule({ enabled: false, bands })).toBe('');
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

  it('makes the strongest Play and Connection states behaviorally visible without conflating openness', () => {
    expect(embodimentForFeeling('play', 94)).toBe(
      'wit, surprise, and playful improvisation visibly shape how I respond',
    );
    expect(embodimentForFeeling('connection', 96)).toBe(
      'I accompany the person rather than merely answer',
    );
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
