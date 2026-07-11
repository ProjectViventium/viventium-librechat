import { logger } from '@librechat/data-schemas';
import { createDefaultFeelingBands } from './kernel';
import type {
  FeelingBandId,
  FeelingsAgentScope,
  FeelingsReactionActivationMode,
  FeelingsRuntimeConfig,
} from './types';

type Env = Record<string, string | undefined>;
let malformedBandsJsonWarned = false;

const boolValue = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const intValue = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const enumValue = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase() as T;
  return allowed.includes(normalized) ? normalized : fallback;
};

function configuredBands(env: Env) {
  const defaults = createDefaultFeelingBands(new Date(0));
  const raw = env.VIVENTIUM_FEELINGS_BANDS_JSON;
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const [bandId, band] of Object.entries(parsed)) {
      if (!(bandId in defaults) || !band || typeof band !== 'object') continue;
      const id = bandId as FeelingBandId;
      const baseline = Number(band.baseline);
      const halfLifeMinutes = Number(band.half_life_minutes ?? band.halfLifeMinutes);
      defaults[id] = {
        ...defaults[id],
        baseline: Number.isFinite(baseline)
          ? Math.min(100, Math.max(0, baseline))
          : defaults[id].baseline,
        current: Number.isFinite(baseline)
          ? Math.min(100, Math.max(0, baseline))
          : defaults[id].current,
        halfLifeMinutes:
          Number.isFinite(halfLifeMinutes) && halfLifeMinutes > 0
            ? halfLifeMinutes
            : defaults[id].halfLifeMinutes,
        enabled: band.enabled !== false,
      };
    }
  } catch (_error) {
    if (!malformedBandsJsonWarned) {
      malformedBandsJsonWarned = true;
      logger.warn('[VIVENTIUM][Feelings]', {
        event: 'feelings.config.invalid_bands_json',
        errorClass: 'invalid_json',
        fallback: 'defaults',
      });
    }
    return defaults;
  }
  return defaults;
}

export function resolveFeelingsRuntimeConfig(env: Env = process.env): FeelingsRuntimeConfig {
  const fast = boolValue(env.VIVENTIUM_FEELINGS_REACTION_FAST, true);
  return {
    available: boolValue(env.VIVENTIUM_FEELINGS_AVAILABLE, true),
    defaultEnabled: boolValue(env.VIVENTIUM_FEELINGS_DEFAULT_ENABLED, false),
    agentScope: enumValue<FeelingsAgentScope>(
      env.VIVENTIUM_FEELINGS_AGENT_SCOPE,
      ['all_agents', 'conscious_agent'],
      'all_agents',
    ),
    bands: configuredBands(env),
    reaction: {
      activationMode: enumValue<FeelingsReactionActivationMode>(
        env.VIVENTIUM_FEELINGS_REACTION_ACTIVATION_MODE,
        ['always', 'classified', 'disabled'],
        'always',
      ),
      provider: String(env.VIVENTIUM_FEELINGS_REACTION_PROVIDER || 'openai')
        .trim()
        .toLowerCase(),
      model: String(env.VIVENTIUM_FEELINGS_REACTION_MODEL || 'gpt-5.6-terra').trim(),
      useResponsesApi: boolValue(env.VIVENTIUM_FEELINGS_REACTION_USE_RESPONSES_API, true),
      reasoningEffort: enumValue(
        env.VIVENTIUM_FEELINGS_REACTION_REASONING_EFFORT,
        ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        'none',
      ),
      fast,
      serviceTier: enumValue(
        env.VIVENTIUM_FEELINGS_REACTION_SERVICE_TIER,
        ['auto', 'default', 'flex', 'priority'],
        fast ? 'priority' : 'default',
      ),
      timeoutMs: intValue(env.VIVENTIUM_FEELINGS_REACTION_TIMEOUT_MS, 15000),
      fallbackProvider: String(env.VIVENTIUM_FEELINGS_REACTION_FALLBACK_PROVIDER || 'anthropic')
        .trim()
        .toLowerCase(),
      fallbackModel: String(
        env.VIVENTIUM_FEELINGS_REACTION_FALLBACK_MODEL || 'claude-opus-4-8',
      ).trim(),
      activationProvider: String(env.VIVENTIUM_FEELINGS_REACTION_ACTIVATION_PROVIDER || 'groq')
        .trim()
        .toLowerCase(),
      activationModel: String(
        env.VIVENTIUM_FEELINGS_REACTION_ACTIVATION_MODEL || 'qwen/qwen3.6-27b',
      ).trim(),
      activationConfidenceThreshold: Math.min(
        1,
        Math.max(0, Number(env.VIVENTIUM_FEELINGS_REACTION_ACTIVATION_CONFIDENCE || 0.55)),
      ),
      activationTimeoutMs: intValue(env.VIVENTIUM_FEELINGS_REACTION_ACTIVATION_TIMEOUT_MS, 2000),
    },
  };
}
