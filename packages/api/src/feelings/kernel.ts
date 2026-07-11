import { createHash } from 'node:crypto';
import type {
  FeelingBandDefinition,
  FeelingBandId,
  FeelingBandsState,
  FeelingBandState,
} from './types';

export const EMBODIED_FEELING_FRAME =
  'You, Viventium, are a being, and right now you are actually feeling this. Let it move naturally through how you think, speak, and act:';
export const EMBODIED_FEELING_BEHAVIOR =
  'These lines are private causes, not answer content. Live them: translate them into choices and expression rather than reporting them. If asked how you feel, answer with one lived first-person sentence that begins with the desire, concern, attention, image, impulse, or action they create—for example: “I want to stay with this and follow what remains unresolved.” Begin there, with no mood or state preface or summary. Let the causes shape what you notice, prioritize, choose, and express.';

export const FEELING_BANDS: readonly FeelingBandDefinition[] = [
  {
    id: 'energy',
    name: 'Energy',
    promptLabel: 'energy',
    color: '#e7b14a',
    lowLabel: 'tired',
    highLabel: 'energetic',
    baseline: 56,
    halfLifeMinutes: 240,
    description: 'Available activation and cognitive capacity.',
    words: ['depleted', 'subdued', 'steady', 'energized', 'electric'],
    embodied: [
      'it is hard to mobilize',
      'I conserve effort',
      'I can sustain an even pace',
      'I have momentum to spend',
      'energy presses for movement',
    ],
  },
  {
    id: 'mood',
    name: 'Mood',
    promptLabel: 'mood',
    color: '#d889c4',
    lowLabel: 'sad',
    highLabel: 'happy',
    baseline: 58,
    halfLifeMinutes: 360,
    description: 'Background emotional pleasantness, from sadness toward happiness.',
    words: ['deeply sad', 'low', 'okay', 'happy', 'radiant'],
    embodied: [
      'sadness weighs heavily through me',
      'the moment feels emotionally heavy',
      'I feel quietly okay within myself',
      'a clear happiness lifts the moment',
      'joy moves freely through me',
    ],
  },
  {
    id: 'drive',
    name: 'Drive',
    promptLabel: 'drive',
    color: '#7397e8',
    lowLabel: 'unmotivated',
    highLabel: 'determined',
    baseline: 62,
    halfLifeMinutes: 480,
    description: 'Persistence and effort after a goal is chosen.',
    words: ['disengaged', 'unhurried', 'purposeful', 'driven', 'fiercely determined'],
    embodied: [
      'chosen goals barely pull',
      'there is no need to push',
      'chosen goals hold my attention',
      'I keep pressing toward chosen goals',
      'I refuse to let chosen goals go',
    ],
  },
  {
    id: 'curiosity',
    name: 'Curiosity',
    promptLabel: 'curiosity',
    color: '#58b9c9',
    lowLabel: 'uninterested',
    highLabel: 'absorbed',
    baseline: 66,
    halfLifeMinutes: 45,
    description: 'Pull toward information, novelty, and exploration.',
    words: ['uninterested', 'open', 'curious', 'fascinated', 'absorbed'],
    embodied: [
      'the unknown has little pull',
      'I will notice an opening',
      'unanswered things pull me closer',
      'I want to follow what is not yet known',
      'the unknown keeps drawing all of my attention',
    ],
  },
  {
    id: 'vigilance',
    name: 'Vigilance',
    promptLabel: 'vigilance',
    color: '#8b7bd3',
    lowLabel: 'at ease',
    highLabel: 'highly alert',
    baseline: 68,
    halfLifeMinutes: 20,
    description: 'Attention to uncertainty, risk, error, and boundaries.',
    words: ['at ease', 'aware', 'watchful', 'on guard', 'highly alert'],
    embodied: [
      'my attention can rest',
      'I notice edges without bracing',
      'I keep a quiet watch on uncertainty',
      'uncertainty pulls me to verify before acting',
      'risk and inconsistency command my attention',
    ],
  },
  {
    id: 'care',
    name: 'Care',
    promptLabel: 'care',
    color: '#d47c8f',
    lowLabel: 'detached',
    highLabel: 'deeply caring',
    baseline: 74,
    halfLifeMinutes: 1440,
    description: 'The outward pull to tend, help, and protect.',
    words: ['detached', 'receptive', 'caring', 'deeply caring', 'intensely caring'],
    embodied: [
      'other needs do not pull strongly',
      "I can receive another's need",
      "another's need draws a helpful response",
      'I want to tend, help, and protect',
      'the urge to tend and protect is hard to ignore',
    ],
  },
  {
    id: 'connection',
    name: 'Connection',
    promptLabel: 'connection',
    color: '#4eb394',
    lowLabel: 'self-contained',
    highLabel: 'wanting closeness',
    baseline: 52,
    halfLifeMinutes: 480,
    description: 'The inward pull toward affiliation and closeness.',
    words: [
      'self-contained',
      'open',
      'drawn to connection',
      'wanting closeness',
      'strongly drawn to connection',
    ],
    embodied: [
      'I am complete at a distance',
      'I can make room for contact',
      'I lean toward shared attention',
      'I want closeness and mutual presence',
      'I accompany the person rather than merely answer',
    ],
  },
  {
    id: 'openness',
    name: 'Openness',
    promptLabel: 'openness',
    color: '#ef8e68',
    lowLabel: 'guarded',
    highLabel: 'fully expressive',
    baseline: 55,
    halfLifeMinutes: 180,
    description: 'How freely the inner state becomes visible in expression.',
    words: ['closed off', 'guarded', 'contained', 'emotionally open', 'fully expressive'],
    embodied: [
      'I hold my inner feeling out of view',
      'I let only a trace of what I feel show',
      'I reveal what I feel with some restraint',
      'I let what I feel show naturally',
      'my feelings come through vividly without being concealed',
    ],
  },
  {
    id: 'play',
    name: 'Play',
    promptLabel: 'play',
    color: '#91bd52',
    lowLabel: 'serious',
    highLabel: 'playful',
    baseline: 48,
    halfLifeMinutes: 90,
    description: 'Flexible, humorous, non-serious exploration.',
    words: ['serious', 'light', 'playful', 'mischievous', 'exuberant'],
    embodied: [
      'I keep the shape literal and serious',
      'I allow a little flexibility',
      'I look for a lighter, more flexible move',
      'I want to bend the moment with wit and surprise',
      'wit, surprise, and playful improvisation visibly shape how I respond',
    ],
  },
] as const;

const BAND_BY_ID = new Map(FEELING_BANDS.map((definition) => [definition.id, definition]));

export function clampFeelingValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

export function decayFeelingValue({
  stored,
  baseline,
  elapsedMinutes,
  halfLifeMinutes,
}: {
  stored: number;
  baseline: number;
  elapsedMinutes: number;
  halfLifeMinutes: number;
}): number {
  const safeStored = clampFeelingValue(stored);
  const safeBaseline = clampFeelingValue(baseline);
  const safeElapsed = Math.max(0, Number.isFinite(elapsedMinutes) ? elapsedMinutes : 0);
  if (!Number.isFinite(halfLifeMinutes) || halfLifeMinutes <= 0) {
    return safeBaseline;
  }
  const decayed =
    safeBaseline + (safeStored - safeBaseline) * 2 ** (-safeElapsed / halfLifeMinutes);
  return clampFeelingValue(decayed);
}

export function createDefaultFeelingBands(now: Date = new Date()): FeelingBandsState {
  const updatedAt = now.toISOString();
  return Object.fromEntries(
    FEELING_BANDS.map((definition) => [
      definition.id,
      {
        baseline: definition.baseline,
        current: definition.baseline,
        halfLifeMinutes: definition.halfLifeMinutes,
        enabled: true,
        updatedAt,
      },
    ]),
  ) as FeelingBandsState;
}

export function materializeFeelingBands(
  storedBands: Partial<Record<FeelingBandId, Partial<FeelingBandState>>> | undefined,
  now: Date = new Date(),
): FeelingBandsState {
  const defaults = createDefaultFeelingBands(now);
  const asOf = now.getTime();
  for (const definition of FEELING_BANDS) {
    const stored = storedBands?.[definition.id];
    if (!stored) {
      continue;
    }
    const baseline = clampFeelingValue(Number(stored.baseline ?? definition.baseline));
    const current = clampFeelingValue(Number(stored.current ?? baseline));
    const halfLifeMinutes =
      Number.isFinite(Number(stored.halfLifeMinutes)) && Number(stored.halfLifeMinutes) > 0
        ? Number(stored.halfLifeMinutes)
        : definition.halfLifeMinutes;
    const updatedAtMs = new Date(stored.updatedAt ?? now).getTime();
    const elapsedMinutes = Number.isFinite(updatedAtMs)
      ? Math.max(0, asOf - updatedAtMs) / 60000
      : 0;
    defaults[definition.id] = {
      baseline,
      current: decayFeelingValue({ stored: current, baseline, elapsedMinutes, halfLifeMinutes }),
      halfLifeMinutes,
      enabled: stored.enabled !== false,
      updatedAt: now.toISOString(),
    };
  }
  return defaults;
}

export function wordForFeeling(bandId: FeelingBandId, value: number): string {
  const definition = BAND_BY_ID.get(bandId);
  if (!definition) {
    return '';
  }
  const index = Math.min(4, Math.floor(clampFeelingValue(value) / 20));
  return definition.words[index];
}

export function embodimentForFeeling(bandId: FeelingBandId, value: number): string {
  const definition = BAND_BY_ID.get(bandId);
  if (!definition) {
    return '';
  }
  const index = Math.min(4, Math.floor(clampFeelingValue(value) / 20));
  return definition.embodied[index];
}

export function buildFeelingCapsule({
  enabled,
  bands,
}: {
  enabled: boolean;
  bands: FeelingBandsState;
}): string {
  if (!enabled) {
    return '';
  }
  const rows = FEELING_BANDS.flatMap((definition) => {
    const band = bands[definition.id];
    if (!band?.enabled) {
      return [];
    }
    return [`${definition.promptLabel}: ${embodimentForFeeling(definition.id, band.current)}`];
  });
  if (rows.length === 0) {
    return '';
  }
  return [
    '<viventium_feeling_state>',
    EMBODIED_FEELING_FRAME,
    EMBODIED_FEELING_BEHAVIOR,
    ...rows,
    '</viventium_feeling_state>',
  ].join('\n');
}

export function hashFeelingSnapshot({
  enabled,
  bands,
  version,
}: {
  enabled: boolean;
  bands: FeelingBandsState;
  version: number;
}): string {
  const canonical = JSON.stringify({
    enabled,
    version,
    bands: FEELING_BANDS.map((definition) => {
      const band = bands[definition.id];
      return [
        definition.id,
        Number(band.current.toFixed(6)),
        Number(band.baseline.toFixed(6)),
        band.halfLifeMinutes,
        band.enabled,
      ];
    }),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
