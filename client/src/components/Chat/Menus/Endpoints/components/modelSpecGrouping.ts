/* === VIVENTIUM START ===
 * Feature: Model selector group-to-endpoint normalization.
 * Purpose: Prevent provider confusion when modelSpecs use display-group names (e.g., "OpenAI")
 * while preset endpoints point to a different backend (e.g., azureOpenAI).
 * === VIVENTIUM END === */
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint } from '~/common';

function normalizeGroup(value?: string): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function isSpecMappedToEndpoint(spec: TModelSpec, endpoint: Endpoint): boolean {
  if (spec.preset?.endpoint) {
    return spec.preset.endpoint === endpoint.value;
  }

  const group = spec.group;
  if (!group) {
    return false;
  }

  if (group === endpoint.value) {
    return true;
  }

  const normalizedGroup = normalizeGroup(group);
  if (!normalizedGroup) {
    return false;
  }

  return (
    normalizedGroup === normalizeGroup(endpoint.label) ||
    normalizedGroup === normalizeGroup(endpoint.value)
  );
}

export function isSpecMappedToAnyEndpoint(spec: TModelSpec, endpoints: Endpoint[]): boolean {
  return endpoints.some((endpoint) => isSpecMappedToEndpoint(spec, endpoint));
}
