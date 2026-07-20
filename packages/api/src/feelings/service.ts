import { z } from 'zod';
import {
  buildFeelingCapsule,
  clampFeelingValue,
  FEELING_BANDS,
  hashFeelingSnapshot,
  materializeFeelingBands,
  normalizeFeelingRangePromptOverrides,
  summarizeFeelingRangePromptOverrides,
} from './kernel';
import { resolveFeelingsRuntimeConfig } from './config';
import {
  FEELING_BAND_IDS,
  FEELING_MODEL_REACTION_CAUSES,
  MAX_FEELING_INNER_STATE_CHARS,
  MAX_FEELING_TRAIL_ENTRIES,
} from './types';
import type {
  FeelingBandId,
  FeelingBandsState,
  FeelingDirection,
  FeelingStrength,
  FeelingTrailEntry,
  FeelingsReadSnapshot,
  FeelingInnerState,
  FeelingsReactionActivationMode,
  FeelingRangePromptOverrides,
} from './types';

type Env = Record<string, string | undefined>;
type StoredFeelingState = {
  enabled?: boolean;
  bands?: Partial<Record<FeelingBandId, Record<string, unknown>>>;
  rangePromptOverrides?: FeelingRangePromptOverrides;
  reactionInstruction?: string;
  reactionActivationMode?: FeelingsReactionActivationMode;
  innerState?: FeelingInnerState | null;
  trail?: FeelingTrailEntry[];
  reactionHealth?: FeelingsReadSnapshot['reactionHealth'];
  processedStimulusKeys?: string[];
  version?: number;
};

export const DEFAULT_REACTION_INSTRUCTION =
  'React to what genuinely moves Viventium. Let each change match how much the moment matters. Move only the feelings the moment actually touches, and leave nature unchanged.';

const LEGACY_DEFAULT_REACTION_INSTRUCTIONS = new Set([
  'React to what genuinely moves Viventium. Prefer small natural changes. Move only the feelings the moment actually touches, and leave nature unchanged.',
]);

const DEFAULT_READ_CACHE_TTL_MS = 5000;
const readCache = new Map<string, { expiresAt: number; value: FeelingsReadSnapshot }>();
const readCacheGenerationTokens = new Map<string, object>();

function readCacheGenerationToken(key: string): object {
  const existing = readCacheGenerationTokens.get(key);
  if (existing) return existing;
  const token = {};
  readCacheGenerationTokens.set(key, token);
  return token;
}

const reactionChangeSchema = z
  .object({
    band: z.enum(FEELING_BAND_IDS),
    direction: z.enum(['up', 'down']),
    strength: z.enum(['slight', 'clear', 'strong']),
    cause: z.enum(FEELING_MODEL_REACTION_CAUSES),
  })
  .strict();

const reactionOutputSchema = z
  .object({
    changes: z
      .array(reactionChangeSchema)
      .max(FEELING_BAND_IDS.length)
      .superRefine((changes, context) => {
        const seen = new Set<string>();
        changes.forEach((change, index) => {
          if (seen.has(change.band)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Each feeling band may change at most once',
              path: [index, 'band'],
            });
          }
          seen.add(change.band);
        });
      }),
    innerState: z
      .string()
      .trim()
      .min(1)
      .max(MAX_FEELING_INNER_STATE_CHARS)
      .refine((value) => !value.includes('\n') && !value.includes('\r'), {
        message: 'Inner state must be a single line',
      }),
  })
  .strict();

export type FeelingReactionChange = z.infer<typeof reactionChangeSchema>;

export function clearFeelingsReadCache(userId?: string): void {
  if (userId) {
    const key = String(userId);
    readCache.delete(key);
    readCacheGenerationTokens.set(key, {});
    return;
  }
  readCache.clear();
  readCacheGenerationTokens.clear();
}

function mergedStoredBands(
  configuredBands: FeelingBandsState,
  storedBands: StoredFeelingState['bands'],
) {
  return Object.fromEntries(
    FEELING_BANDS.map((definition) => [
      definition.id,
      {
        ...configuredBands[definition.id],
        ...(storedBands?.[definition.id] ?? {}),
      },
    ]),
  ) as Partial<Record<FeelingBandId, Partial<FeelingBandsState[FeelingBandId]>>>;
}

export function createInitialFeelingState({
  now = new Date(),
  env = process.env,
}: {
  now?: Date;
  env?: Env;
} = {}) {
  const config = resolveFeelingsRuntimeConfig(env);
  const bands = materializeFeelingBands(config.bands, now);
  return {
    enabled: config.defaultEnabled,
    bands,
    rangePromptOverrides: {} as FeelingRangePromptOverrides,
    reactionInstruction: DEFAULT_REACTION_INSTRUCTION,
    reactionActivationMode: config.reaction.activationMode,
    innerState: null as FeelingInnerState | null,
    trail: [] as FeelingTrailEntry[],
    reactionHealth: {
      status: 'never' as const,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastDurationMs: null,
      lastErrorClass: null,
      lastErrorDetail: null,
      lastSkipReason: null,
      requestedProvider: config.reaction.provider,
      requestedModel: config.reaction.model,
      requestedServiceTier: config.reaction.serviceTier,
      lastUsedServiceTier: null,
    },
    processedStimulusKeys: [] as string[],
    version: 0,
  };
}

function normalizedInnerState(value: StoredFeelingState['innerState']): FeelingInnerState | null {
  if (!value || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  const generatedAt = new Date(
    value.generatedAt instanceof Date ? value.generatedAt.getTime() : value.generatedAt,
  );
  if (
    !text ||
    text.length > MAX_FEELING_INNER_STATE_CHARS ||
    text.includes('\n') ||
    text.includes('\r') ||
    !Number.isFinite(generatedAt.getTime())
  ) {
    return null;
  }
  return { text, generatedAt: generatedAt.toISOString() };
}

function normalizedReactionInstruction(value: StoredFeelingState['reactionInstruction']): string {
  const instruction = typeof value === 'string' ? value.trim() : '';
  if (!instruction || LEGACY_DEFAULT_REACTION_INSTRUCTIONS.has(instruction)) {
    return DEFAULT_REACTION_INSTRUCTION;
  }
  return instruction;
}

export async function loadFeelingsReadContext({
  userId,
  getFeelingState,
  now = new Date(),
  env = process.env,
  bypassCache = false,
}: {
  userId: string;
  getFeelingState: (userId: string) => Promise<StoredFeelingState | null>;
  now?: Date;
  env?: Env;
  bypassCache?: boolean;
}): Promise<FeelingsReadSnapshot> {
  const key = String(userId);
  const nowMs = now.getTime();
  const cached = !bypassCache ? readCache.get(key) : undefined;
  if (cached && cached.expiresAt > nowMs) {
    return { ...cached.value, cacheHit: true };
  }
  // A mutation can invalidate this user while the database read is still in flight. Retain the
  // snapshot for this caller, but only cache it if its generation is still current afterward.
  const cacheGeneration = !bypassCache ? readCacheGenerationToken(key) : null;

  const config = resolveFeelingsRuntimeConfig(env);
  const stored = config.available ? await getFeelingState(key) : null;
  const initial = createInitialFeelingState({ now, env });
  const bands = materializeFeelingBands(mergedStoredBands(config.bands, stored?.bands), now);
  const enabled = config.available && (stored?.enabled ?? initial.enabled);
  const version = Number.isInteger(stored?.version) ? Number(stored?.version) : 0;
  const rangePromptOverrides = normalizeFeelingRangePromptOverrides(stored?.rangePromptOverrides);
  const rangePromptSummary = summarizeFeelingRangePromptOverrides({
    bands,
    rangePromptOverrides,
  });
  const capsule = buildFeelingCapsule({ enabled, bands, rangePromptOverrides });
  const snapshot: FeelingsReadSnapshot = {
    available: config.available,
    enabled,
    agentScope: config.agentScope,
    version,
    asOf: now.toISOString(),
    bands,
    rangePromptOverrides,
    ...rangePromptSummary,
    capsule,
    snapshotHash: hashFeelingSnapshot({ enabled, bands, version, rangePromptOverrides }),
    reactionInstruction: normalizedReactionInstruction(stored?.reactionInstruction),
    reactionActivationMode: stored?.reactionActivationMode ?? config.reaction.activationMode,
    innerState: normalizedInnerState(stored?.innerState),
    trail: Array.isArray(stored?.trail) ? stored.trail.slice(-MAX_FEELING_TRAIL_ENTRIES) : [],
    reactionHealth: stored?.reactionHealth ?? initial.reactionHealth,
    cacheHit: false,
  };
  if (
    !bypassCache &&
    cacheGeneration != null &&
    readCacheGenerationTokens.get(key) === cacheGeneration
  ) {
    readCache.set(key, {
      expiresAt: nowMs + DEFAULT_READ_CACHE_TTL_MS,
      value: snapshot,
    });
  }
  return snapshot;
}

function unwrapJson(raw: string): string {
  const trimmed = String(raw || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseFeelingReactionOutput(raw: string): {
  changes: FeelingReactionChange[];
  innerState: string;
} {
  try {
    const parsed = JSON.parse(unwrapJson(raw));
    return reactionOutputSchema.parse(parsed);
  } catch (error) {
    throw new Error('Invalid Emotional Reaction output', { cause: error });
  }
}

const STRENGTH_DELTAS: Record<FeelingStrength, number> = {
  slight: 3,
  clear: 8,
  strong: 15,
};

function strengthForDelta(delta: number): FeelingStrength {
  if (delta <= 4) return 'slight';
  if (delta <= 10) return 'clear';
  return 'strong';
}

export function applyFeelingOperations({
  bands,
  changes,
  now = new Date(),
}: {
  bands: FeelingBandsState;
  changes: FeelingReactionChange[];
  now?: Date;
}): { bands: FeelingBandsState; trail: FeelingTrailEntry[] } {
  const nextBands = structuredClone(bands) as FeelingBandsState;
  const trail: FeelingTrailEntry[] = [];
  for (const change of changes.slice(0, FEELING_BAND_IDS.length)) {
    const band = nextBands[change.band];
    if (!band?.enabled) continue;
    const before = clampFeelingValue(band.current);
    const signedDelta = STRENGTH_DELTAS[change.strength] * (change.direction === 'up' ? 1 : -1);
    const after = clampFeelingValue(before + signedDelta);
    if (after === before) continue;
    nextBands[change.band] = { ...band, current: after, updatedAt: now.toISOString() };
    trail.push({
      timestamp: now.toISOString(),
      band: change.band,
      direction: change.direction,
      strength: change.strength,
      sourceType: 'user_turn',
      cause: change.cause,
      before,
      after,
    });
  }
  return { bands: nextBands, trail };
}

export function prepareManualFeelingPatch({
  bands,
  bandId,
  change,
  now = new Date(),
}: {
  bands: FeelingBandsState;
  bandId: FeelingBandId;
  change: {
    baseline?: number;
    current?: number;
    halfLifeMinutes?: number;
    enabled?: boolean;
    reset?: boolean;
  };
  now?: Date;
}): { band: FeelingBandsState[FeelingBandId]; trail: FeelingTrailEntry[] } {
  const existing = bands[bandId];
  if (!existing) throw new Error('Unknown feeling band');
  const band = { ...existing, updatedAt: now.toISOString() };
  const trail: FeelingTrailEntry[] = [];
  if (change.baseline != null) band.baseline = clampFeelingValue(Number(change.baseline));
  if (change.halfLifeMinutes != null) {
    const halfLife = Number(change.halfLifeMinutes);
    if (!Number.isFinite(halfLife) || halfLife < 1) throw new Error('Invalid half-life');
    band.halfLifeMinutes = halfLife;
  }
  if (typeof change.enabled === 'boolean') band.enabled = change.enabled;
  const before = band.current;
  if (change.reset === true) band.current = band.baseline;
  else if (change.current != null) band.current = clampFeelingValue(Number(change.current));
  if (band.current !== before) {
    const direction: FeelingDirection = band.current > before ? 'up' : 'down';
    trail.push({
      timestamp: now.toISOString(),
      band: bandId,
      direction,
      strength: strengthForDelta(Math.abs(band.current - before)),
      sourceType: change.reset === true ? 'reset' : 'manual',
      cause: change.reset === true ? 'reset_to_nature' : 'manual_adjustment',
      before,
      after: band.current,
    });
  }
  return { band, trail };
}
