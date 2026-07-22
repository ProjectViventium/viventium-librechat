/**
 * === VIVENTIUM START ===
 * Feature: Config-driven Agent Builder activation model options.
 * Purpose: Derive choices from live catalog and persisted route metadata without provider heuristics.
 * === VIVENTIUM END ===
 */

import type { OptionWithIcon } from '~/common';
import type { ActivationConfig } from 'librechat-data-provider';

type ActivationRoute = Pick<ActivationConfig, 'provider' | 'model'>;
type ModelsByProvider = Record<string, string[]>;

export function activationModelKey(route?: Partial<ActivationRoute> | null): string {
  const model = String(route?.model || '').trim();
  const provider = String(route?.provider || '').trim();
  return model && provider ? `${model}|${provider}` : '';
}

export function parseActivationModelKey(value: string): ActivationRoute {
  const separator = value.lastIndexOf('|');
  if (separator <= 0 || separator >= value.length - 1) {
    return { model: '', provider: '' };
  }
  return {
    model: value.slice(0, separator),
    provider: value.slice(separator + 1),
  };
}

export function buildActivationModelOptions(
  modelsByProvider: ModelsByProvider,
  current?: Partial<ActivationRoute> | null,
): OptionWithIcon[] {
  const options = Object.entries(modelsByProvider).flatMap(([provider, models]) =>
    (Array.isArray(models) ? models : []).map((model) => ({
      label: `${model} (${provider})`,
      value: activationModelKey({ provider, model }),
    })),
  );
  const currentKey = activationModelKey(current);
  if (currentKey && !options.some((option) => option.value === currentKey)) {
    options.unshift({
      label: `${current?.model} (${current?.provider}) — configured`,
      value: currentKey,
    });
  }
  return options;
}

export function resolveDefaultActivationRoute(
  cortices: Array<{ activation?: Partial<ActivationRoute> | null }>,
  modelsByProvider: ModelsByProvider,
): ActivationRoute {
  const counts = new Map<string, { route: ActivationRoute; count: number; firstIndex: number }>();
  cortices.forEach((cortex, index) => {
    const route = {
      provider: String(cortex.activation?.provider || '').trim(),
      model: String(cortex.activation?.model || '').trim(),
    };
    const key = activationModelKey(route);
    if (!key) return;
    const current = counts.get(key);
    counts.set(key, {
      route,
      count: (current?.count || 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  });

  const configured = [...counts.values()].sort(
    (left, right) => right.count - left.count || left.firstIndex - right.firstIndex,
  )[0];
  if (configured) return configured.route;

  for (const [provider, models] of Object.entries(modelsByProvider)) {
    const model = Array.isArray(models) ? models.find((candidate) => candidate.trim()) : undefined;
    if (model) return { provider, model };
  }
  return { provider: '', model: '' };
}
