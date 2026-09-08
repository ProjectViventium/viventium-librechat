/* === VIVENTIUM START === Existing compiled prompt owner shared by typed runtime and legacy adapters. === */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { logger } from '@librechat/data-schemas';

type PromptVariable =
  | string
  | number
  | boolean
  | null
  | undefined
  | PromptVariable[]
  | { [key: string]: PromptVariable };
export type PromptVariables = { [key: string]: PromptVariable };
type PromptMetadata = {
  includes?: string[];
  strict_variables?: boolean;
  [key: string]: PromptVariable;
};
type PromptBundle = {
  prompt_count?: number;
  prompts?: { [id: string]: { body?: string; metadata?: PromptMetadata } };
};

export const PROMPT_BUNDLE_ENV = 'VIVENTIUM_PROMPT_BUNDLE_PATH';
const VARIABLE_RE = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;
export const KNOWN_RUNTIME_PLACEHOLDERS = new Set([
  'critical_operating_instructions',
  'native_capability_inventory',
  'completion_contract',
  'safety_checkpoint',
  'current_user',
  'current_date',
  'current_datetime',
  'glasshive_worker_capability_summary',
  'glasshive_worker_execution_instruction',
  'iso_datetime',
]);

let cachedBundle: PromptBundle | null | undefined = undefined;
let cachedBundlePath = '';
let cachedFileIdentity = '';
let cachedBundleSha256 = '';
let cachedLoadError: Error | null = null;
const warnedFallbackKeys = new Set();

function loadPromptBundle() {
  const nextBundlePath = (process.env[PROMPT_BUNDLE_ENV] || '').trim();
  if (nextBundlePath !== cachedBundlePath) {
    warnedFallbackKeys.clear();
    cachedFileIdentity = '';
  }
  cachedBundlePath = nextBundlePath;
  if (!cachedBundlePath) {
    cachedBundle = null;
    cachedFileIdentity = '';
    cachedBundleSha256 = '';
    cachedLoadError = null;
    return cachedBundle;
  }

  try {
    const stat = fs.statSync(cachedBundlePath, { bigint: true });
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (cachedBundle !== undefined && identity === cachedFileIdentity) {
      return cachedBundle;
    }
    const bytes = fs.readFileSync(cachedBundlePath, 'utf8');
    const parsed = JSON.parse(bytes);
    cachedBundle = parsed && typeof parsed === 'object' ? parsed : null;
    cachedFileIdentity = identity;
    cachedBundleSha256 = cachedBundle
      ? crypto.createHash('sha256').update(bytes).digest('hex')
      : '';
    cachedLoadError = null;
  } catch (error) {
    cachedBundle = null;
    cachedFileIdentity = '';
    cachedBundleSha256 = '';
    cachedLoadError = error instanceof Error ? error : new Error(String(error));
  }
  return cachedBundle;
}

export function getPromptBundleStatus() {
  loadPromptBundle();
  return {
    loaded: Boolean(cachedBundle && cachedBundle.prompts),
    path: cachedBundlePath,
    error: cachedLoadError ? cachedLoadError.message : '',
    promptCount: cachedBundle?.prompt_count || 0,
    sha256: cachedBundleSha256,
  };
}

export function getPromptMetadata(promptId: string) {
  const bundle = loadPromptBundle();
  const metadata = bundle?.prompts?.[promptId]?.metadata;
  return metadata && typeof metadata === 'object' ? metadata : null;
}

function lookupVariable(variables: PromptVariables, key: string) {
  let current: PromptVariable = variables || {};
  for (const segment of String(key).split('.')) {
    if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as PromptVariables)[segment];
      continue;
    }
    throw new Error(`Missing prompt variable: ${key}`);
  }
  if (Array.isArray(current)) {
    return current.map((item) => String(item)).join(', ');
  }
  if (current == null) {
    throw new Error(`Prompt variable is null: ${key}`);
  }
  return String(current);
}

function substituteVariables(text: string, variables: PromptVariables, { strict = false } = {}) {
  return String(text || '').replace(VARIABLE_RE, (match, key) => {
    try {
      return lookupVariable(variables, key);
    } catch (error) {
      if (strict) {
        throw error;
      }
      if (!KNOWN_RUNTIME_PLACEHOLDERS.has(String(key))) {
        throw new Error(
          `Unknown unfilled prompt variable ${key}; add promptVars or an allowed runtime placeholder`,
        );
      }
      return match;
    }
  });
}

function renderPromptFromBundle(
  promptId: string,
  bundle: PromptBundle,
  variables: PromptVariables = {},
  stack: string[] = [],
): string {
  if (stack.includes(promptId)) {
    throw new Error(`Prompt include cycle detected: ${[...stack, promptId].join(' -> ')}`);
  }
  const prompt = bundle?.prompts?.[promptId];
  if (!prompt) {
    throw new Error(`Unknown prompt id: ${promptId}`);
  }

  const includes = Array.isArray(prompt.metadata?.includes) ? prompt.metadata.includes : [];
  const parts = includes.map((includeId) =>
    renderPromptFromBundle(String(includeId), bundle, variables, [...stack, promptId]).trim(),
  );
  parts.push(String(prompt.body || '').trim());
  return substituteVariables(parts.filter(Boolean).join('\n\n').trim(), variables, {
    strict: prompt.metadata?.strict_variables === true,
  });
}

function warnPromptFallback(promptId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${promptId}:${message || 'unknown'}`;
  if (warnedFallbackKeys.has(key)) {
    return;
  }
  warnedFallbackKeys.add(key);
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      `[VIVENTIUM][prompt-registry] Falling back to inline prompt for ${promptId}: ${message}`,
    );
  }
}

export function getPromptText(promptId: string, fallback = '', variables: PromptVariables = {}) {
  const bundle = loadPromptBundle();
  if (!bundle?.prompts) {
    return fallback;
  }
  try {
    return renderPromptFromBundle(promptId, bundle, variables).trim() || fallback;
  } catch (error) {
    warnPromptFallback(promptId, error);
    return fallback;
  }
}

export function getRequiredPromptText(promptId: string, variables: PromptVariables = {}) {
  const bundle = loadPromptBundle();
  if (!bundle?.prompts) {
    throw Object.assign(new Error('prompt_bundle_unavailable'), {
      code: 'prompt_bundle_unavailable',
    });
  }
  try {
    const text = renderPromptFromBundle(promptId, bundle, variables).trim();
    if (!text) throw new Error(`Empty required prompt: ${promptId}`);
    return text;
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: 'required_prompt_invalid',
    });
  }
}

export function resetPromptRegistryForTests() {
  cachedBundle = undefined;
  cachedBundlePath = '';
  cachedFileIdentity = '';
  cachedBundleSha256 = '';
  cachedLoadError = null;
  warnedFallbackKeys.clear();
}
