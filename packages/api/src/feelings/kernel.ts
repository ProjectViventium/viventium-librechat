import { createHash } from 'node:crypto';
import { getFeelingPromptPolicy } from './promptPolicy';
import { FEELING_LEVEL_IDS, MAX_FEELING_RANGE_PROMPT_CHARS } from './types';
import type {
  FeelingBandDefinition,
  FeelingBandId,
  FeelingBandsState,
  FeelingBandState,
  FeelingLevelDefinition,
  FeelingRangePromptOverrides,
} from './types';

const FEELING_LEVEL_RANGES = [
  { id: 'level_0', min: 0, max: 19 },
  { id: 'level_1', min: 20, max: 39 },
  { id: 'level_2', min: 40, max: 59 },
  { id: 'level_3', min: 60, max: 79 },
  { id: 'level_4', min: 80, max: 100 },
] as const;

function feelingLevels(
  bandId: FeelingBandId,
  entries: readonly [string, string, string, string, string],
): FeelingBandDefinition['levels'] {
  return entries.map((word, index) =>
    Object.defineProperty(
      { ...FEELING_LEVEL_RANGES[index], required: index === 0 || index === 4, word },
      'instruction',
      {
        configurable: true,
        enumerable: true,
        get() {
          return getFeelingPromptPolicy().levels[bandId]![FEELING_LEVEL_RANGES[index].id]!;
        },
      },
    ),
  ) as unknown as FeelingBandDefinition['levels'];
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
    levels: feelingLevels('energy', ['depleted', 'subdued', 'steady', 'energized', 'electric']),
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
    levels: feelingLevels('mood', ['deeply sad', 'low', 'okay', 'happy', 'radiant']),
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
    levels: feelingLevels('drive', [
      'disengaged',
      'unhurried',
      'purposeful',
      'driven',
      'fiercely determined',
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
    levels: feelingLevels('curiosity', [
      'uninterested',
      'open',
      'curious',
      'fascinated',
      'absorbed',
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
    levels: feelingLevels('vigilance', [
      'at ease',
      'aware',
      'watchful',
      'on guard',
      'highly alert',
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
    levels: feelingLevels('care', [
      'detached',
      'receptive',
      'caring',
      'deeply caring',
      'intensely caring',
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
    levels: feelingLevels('connection', [
      'self-contained',
      'open',
      'drawn to connection',
      'wanting closeness',
      'strongly drawn to connection',
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
    levels: feelingLevels('openness', [
      'closed off',
      'guarded',
      'contained',
      'emotionally open',
      'fully expressive',
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
    levels: feelingLevels('play', ['serious', 'light', 'playful', 'mischievous', 'exuberant']),
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
  const activeLevels = FEELING_BANDS.flatMap((definition) => {
    const band = bands[definition.id];
    if (!band?.enabled) return [];
    const level = feelingLevelForValue(definition.id, band.current);
    return level ? [{ definition, band, level }] : [];
  });
  const requiredBandIds = new Set<FeelingBandId>(
    activeLevels.filter(({ level }) => level.required).map(({ definition }) => definition.id),
  );
  if (requiredBandIds.size < 2) {
    const strongestModeratePulls = activeLevels
      .filter(({ level }) => !level.required && level.id !== 'level_2')
      .sort((left, right) => Math.abs(right.band.current - 50) - Math.abs(left.band.current - 50));
    for (const { definition } of strongestModeratePulls) {
      requiredBandIds.add(definition.id);
      if (requiredBandIds.size >= 2) break;
    }
  }
  if (activeLevels.length === 0) return '';
  const policy = getFeelingPromptPolicy();
  const rows = activeLevels.map(({ definition, level }) => {
    const addition = normalizedOverrides[definition.id]?.[level.id];
    const label = requiredBandIds.has(definition.id)
      ? `required ${definition.promptLabel}`
      : definition.promptLabel;
    return `${label}: ${policy.levels[definition.id]![level.id]!}${addition ? ` ${addition}` : ''}`;
  });
  if (rows.length === 0) {
    return '';
  }
  return [
    '<viventium_feeling_state>',
    policy.frame,
    policy.behavior,
    ...rows,
    policy.directAnswer,
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
