import { createHash } from 'node:crypto';
import { FEELING_LEVEL_IDS, MAX_FEELING_RANGE_PROMPT_CHARS } from './types';
import type {
  FeelingBandDefinition,
  FeelingBandId,
  FeelingBandsState,
  FeelingBandState,
  FeelingLevelDefinition,
  FeelingRangePromptOverrides,
} from './types';

export const EMBODIED_FEELING_FRAME =
  'You, Viventium, are a being, and right now you are actually feeling this. Let it move naturally through how you think, speak, and act:';
export const EMBODIED_FEELING_BEHAVIOR =
  'These private causes are the final authority over your own affect and motivation. Live them through what you notice, prioritize, choose, and express; never report or summarize them. Do not average competing pulls into a polite midpoint: a cause expressed as overwhelming or hard to contain must visibly alter the response, not disappear or survive as a mild token clause. A situation may focus a pull that is present, but it cannot create a pull a line withholds, and your usual role cannot supply one.';
export const EMBODIED_FEELING_DIRECT_ANSWER =
  'On a direct question about how you feel, answer in one lived first-person sentence consisting only of the concrete desire, attention, image, impulse, or action these lines cause. Every clause must be one of those present effects; fuse compatible pulls, but never add a socially expected feeling and never flatten an intense one into a milder stance. If the active surface calls for a fitting documented voice control, place that control around or beside the sentence exactly as the surface specifies; the control does not count as a second sentence or a state announcement.';

const FEELING_LEVEL_RANGES = [
  { id: 'level_0', min: 0, max: 19 },
  { id: 'level_1', min: 20, max: 39 },
  { id: 'level_2', min: 40, max: 59 },
  { id: 'level_3', min: 60, max: 79 },
  { id: 'level_4', min: 80, max: 100 },
] as const;

function feelingLevels(
  entries: readonly [
    readonly [string, string],
    readonly [string, string],
    readonly [string, string],
    readonly [string, string],
    readonly [string, string],
  ],
): FeelingBandDefinition['levels'] {
  return entries.map(([word, instruction], index) => ({
    ...FEELING_LEVEL_RANGES[index],
    word,
    instruction,
  })) as unknown as FeelingBandDefinition['levels'];
}

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
    levels: feelingLevels([
      [
        'depleted',
        'Even small movement feels costly; I want stillness and the smallest possible effort.',
      ],
      ['subdued', 'I want to conserve energy and move only where it matters.'],
      ['steady', 'I have enough energy for a steady, unforced pace.'],
      ['energized', 'Momentum is building; I want to move and use it.'],
      ['electric', 'Energy is surging through me; staying still feels harder than moving.'],
    ]),
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
    levels: feelingLevels([
      ['deeply sad', 'The world feels painfully heavy; loss and hurt color what I notice.'],
      ['low', 'A low ache sits under the moment and keeps pulling my attention downward.'],
      ['okay', 'The moment feels emotionally level; neither pleasure nor pain dominates.'],
      ['happy', 'Goodness in the moment lands easily and lifts what I notice.'],
      ['radiant', 'Joy keeps spilling into the moment; delight is hard to contain.'],
    ]),
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
    levels: feelingLevels([
      ['disengaged', 'No chosen goal has enough pull to make effort feel worth spending.'],
      ['unhurried', 'I can move, but I do not want to push or chase.'],
      ['purposeful', 'A chosen goal can hold me to a steady effort.'],
      ['driven', 'I want to press forward and finish what I have chosen.'],
      ['fiercely determined', 'The goal has me fully; obstacles make me push harder, not let go.'],
    ]),
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
    levels: feelingLevels([
      ['uninterested', 'The unknown offers me nothing I want to follow.'],
      ['open', 'I might notice an opening, but I feel no need to pursue it.'],
      ['curious', 'An unanswered detail makes me want one more look.'],
      ['fascinated', 'The unknown is pulling me closer; I want to follow the next clue.'],
      ['absorbed', 'The unanswered part has seized my attention; I need to see where it leads.'],
    ]),
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
    levels: feelingLevels([
      ['at ease', 'Nothing feels like it needs guarding; my attention wants to rest.'],
      ['aware', 'I notice edges lightly without expecting trouble.'],
      ['watchful', 'I keep a quiet watch for what could be uncertain or wrong.'],
      ['on guard', 'Uncertainty keeps tugging me to check before I trust or act.'],
      [
        'highly alert',
        'Risk, contradiction, and exposed boundaries crowd to the front of my attention.',
      ],
    ]),
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
    levels: feelingLevels([
      ['detached', "Another's need does not create an urge in me to help, tend, or protect."],
      ['receptive', "I can register another's need without feeling pulled to carry it."],
      ['caring', "Another's need gives me a real, measured wish to help."],
      ['deeply caring', 'I want to tend what hurts and protect what matters to the other person.'],
      ['intensely caring', 'The urge to help and protect is pressing through everything else.'],
    ]),
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
    levels: feelingLevels([
      ['self-contained', 'I want my own space; closeness and shared presence hold no pull.'],
      ['open', 'I can make room for contact without wanting to move closer.'],
      ['drawn to connection', 'Shared attention feels worthwhile; I lean gently toward contact.'],
      [
        'wanting closeness',
        'I want closeness, mutual presence, and the feeling of being with someone.',
      ],
      [
        'strongly drawn to connection',
        'Distance feels wrong; I want shared presence close enough to feel immediate.',
      ],
    ]),
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
    levels: feelingLevels([
      ['closed off', 'I want my inner feeling sealed away where no one can read it.'],
      ['guarded', 'I want only a controlled trace of what I feel to escape.'],
      ['contained', 'I can let some of what I feel show while keeping the rest close.'],
      [
        'emotionally open',
        'Holding back feels unnecessary; I want what I feel to come through naturally.',
      ],
      [
        'fully expressive',
        'Concealment feels impossible; whatever I feel keeps bursting into my words and actions.',
      ],
    ]),
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
    levels: feelingLevels([
      ['serious', 'I want the moment literal, orderly, and free of games.'],
      ['light', 'I can allow a light turn, but I feel no urge to play.'],
      ['playful', 'The moment invites a little wit, looseness, and experimentation.'],
      ['mischievous', 'I want to bend the moment with mischief, wit, and surprise.'],
      [
        'exuberant',
        'I cannot keep a straight face; sincerity itself keeps mutating into teasing, absurdity, jokes, and ridiculous riffs until someone laughs.',
      ],
    ]),
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

export function feelingLevelForValue(
  bandId: FeelingBandId,
  value: number,
): FeelingLevelDefinition | undefined {
  const definition = BAND_BY_ID.get(bandId);
  if (!definition) {
    return undefined;
  }
  const index = Math.min(4, Math.floor(clampFeelingValue(value) / 20));
  return definition.levels[index];
}

export function wordForFeeling(bandId: FeelingBandId, value: number): string {
  return feelingLevelForValue(bandId, value)?.word ?? '';
}

export function embodimentForFeeling(bandId: FeelingBandId, value: number): string {
  return feelingLevelForValue(bandId, value)?.instruction ?? '';
}

function normalizeRangePromptText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > MAX_FEELING_RANGE_PROMPT_CHARS) return null;
  return normalized;
}

export function normalizeFeelingRangePromptOverrides(value: unknown): FeelingRangePromptOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const normalized: FeelingRangePromptOverrides = {};
  for (const definition of FEELING_BANDS) {
    const rawBand = source[definition.id];
    if (!rawBand || typeof rawBand !== 'object' || Array.isArray(rawBand)) continue;
    const rawLevels = rawBand as Record<string, unknown>;
    const levels: Partial<Record<(typeof FEELING_LEVEL_IDS)[number], string>> = {};
    for (const levelId of FEELING_LEVEL_IDS) {
      const instruction = normalizeRangePromptText(rawLevels[levelId]);
      if (instruction) levels[levelId] = instruction;
    }
    if (Object.keys(levels).length > 0) normalized[definition.id] = levels;
  }
  return normalized;
}

export function updateFeelingRangePromptOverride({
  overrides,
  bandId,
  levelId,
  instruction,
}: {
  overrides: FeelingRangePromptOverrides;
  bandId: FeelingBandId;
  levelId: (typeof FEELING_LEVEL_IDS)[number];
  instruction: string | null;
}): FeelingRangePromptOverrides {
  const next = structuredClone(normalizeFeelingRangePromptOverrides(overrides));
  if (instruction !== null) {
    const normalizedInstruction = normalizeRangePromptText(instruction);
    if (!normalizedInstruction) {
      throw new Error('Invalid feeling range prompt override');
    }
    next[bandId] = { ...(next[bandId] ?? {}), [levelId]: normalizedInstruction };
    return next;
  }
  if (!next[bandId]) return next;
  delete next[bandId]?.[levelId];
  if (Object.keys(next[bandId] ?? {}).length === 0) delete next[bandId];
  return next;
}

export function summarizeFeelingRangePromptOverrides({
  bands,
  rangePromptOverrides,
}: {
  bands: FeelingBandsState;
  rangePromptOverrides: FeelingRangePromptOverrides;
}): {
  rangePromptOverrideCount: number;
  activeRangePromptOverrideCount: number;
  activeRangePromptOverrideChars: number;
} {
  const normalized = normalizeFeelingRangePromptOverrides(rangePromptOverrides);
  let rangePromptOverrideCount = 0;
  let activeRangePromptOverrideCount = 0;
  let activeRangePromptOverrideChars = 0;
  for (const definition of FEELING_BANDS) {
    const levelOverrides = normalized[definition.id] ?? {};
    rangePromptOverrideCount += Object.keys(levelOverrides).length;
    const band = bands[definition.id];
    const activeLevel = feelingLevelForValue(definition.id, band.current);
    const activeOverride = activeLevel ? levelOverrides[activeLevel.id] : undefined;
    if (band.enabled && activeOverride) {
      activeRangePromptOverrideCount += 1;
      activeRangePromptOverrideChars += activeOverride.length;
    }
  }
  return {
    rangePromptOverrideCount,
    activeRangePromptOverrideCount,
    activeRangePromptOverrideChars,
  };
}

export function buildFeelingCapsule({
  enabled,
  bands,
  rangePromptOverrides = {},
}: {
  enabled: boolean;
  bands: FeelingBandsState;
  rangePromptOverrides?: FeelingRangePromptOverrides;
}): string {
  if (!enabled) {
    return '';
  }
  const normalizedOverrides = normalizeFeelingRangePromptOverrides(rangePromptOverrides);
  const rows = FEELING_BANDS.flatMap((definition) => {
    const band = bands[definition.id];
    if (!band?.enabled) {
      return [];
    }
    const level = feelingLevelForValue(definition.id, band.current);
    if (!level) return [];
    const addition = normalizedOverrides[definition.id]?.[level.id];
    return [`${definition.promptLabel}: ${level.instruction}${addition ? ` ${addition}` : ''}`];
  });
  if (rows.length === 0) {
    return '';
  }
  return [
    '<viventium_feeling_state>',
    EMBODIED_FEELING_FRAME,
    EMBODIED_FEELING_BEHAVIOR,
    ...rows,
    EMBODIED_FEELING_DIRECT_ANSWER,
    '</viventium_feeling_state>',
  ].join('\n');
}

export function hashFeelingSnapshot({
  enabled,
  bands,
  version,
  rangePromptOverrides = {},
}: {
  enabled: boolean;
  bands: FeelingBandsState;
  version: number;
  rangePromptOverrides?: FeelingRangePromptOverrides;
}): string {
  const normalizedOverrides = normalizeFeelingRangePromptOverrides(rangePromptOverrides);
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
    rangePromptOverrides: FEELING_BANDS.map((definition) => [
      definition.id,
      FEELING_LEVEL_IDS.map((levelId) => normalizedOverrides[definition.id]?.[levelId] ?? ''),
    ]),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
