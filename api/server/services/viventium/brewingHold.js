/* === VIVENTIUM START ===
 * Feature: Tool Cortex Brewing Hold (v0_3 parity)
 *
 * Purpose:
 * - When a tool-focused cortex activates and the main agent has no matching direct-action surface,
 *   avoid a premature main-agent response that guesses from memory ("I can't access..." /
 *   hallucinated facts).
 * - In v0_3, Brewing notices functioned as a STOP signal for answering until tool work completed.
 *
 * v0_4 Architecture:
 * - Phase A (detect) is time-boxed (fast).
 * - Phase B (execute) is asynchronous; results arrive via a single follow-up message.
 * - When the main agent has a connected direct-action surface for the same activation scope, the
 *   main agent should run first and use its own tools while Phase B remains supplemental.
 *
 * This module provides a deterministic, server-side "holding acknowledgement" so we do NOT rely
 * on the LLM noticing `## Background Processing (Brewing)` in system instructions.
 *
 * Configuration (env vars):
 * - VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED:
 *     - "0" disables
 *     - default: enabled
 * - VIVENTIUM_TOOL_CORTEX_HOLD_TEXT:
 *     - optional fixed override string
 * - VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON:
 *     - optional JSON array of strings (deterministic pick by message id)
 * === VIVENTIUM END === */

const {
  resolveProductivitySpecialistScope,
} = require('~/server/services/viventium/productivitySpecialistContext');
const { isNoResponseOnly } = require('~/server/services/viventium/noResponseTag');

function isEnvDisabled(name) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'disabled';
}

function resolveConfiguredHoldScopeKey(cortex) {
  const scope = resolveProductivitySpecialistScope(cortex);
  if (typeof scope !== 'string' || scope.length === 0) {
    return null;
  }

  return `productivity_${scope}`;
}

function matchesConfigDrivenHoldScope(cortex) {
  return resolveConfiguredHoldScopeKey(cortex) !== null;
}

function isToolHoldCandidate(cortex) {
  if (!cortex || typeof cortex !== 'object') {
    return false;
  }

  return matchesConfigDrivenHoldScope(cortex);
}

function collectConfiguredHoldScopeKeys(cortices) {
  if (!Array.isArray(cortices) || cortices.length === 0) {
    return [];
  }

  const seen = new Set();
  const scopeKeys = [];
  for (const cortex of cortices) {
    const scopeKey = resolveConfiguredHoldScopeKey(cortex);
    if (!scopeKey || seen.has(scopeKey)) {
      continue;
    }
    seen.add(scopeKey);
    scopeKeys.push(scopeKey);
  }

  return scopeKeys;
}

function collectDirectActionScopeKeysFromCortices(cortices) {
  if (!Array.isArray(cortices) || cortices.length === 0) {
    return [];
  }

  const seen = new Set();
  const scopeKeys = [];
  const addScope = (value) => {
    const scopeKey = String(value || '').trim();
    if (!scopeKey || seen.has(scopeKey)) {
      return;
    }
    seen.add(scopeKey);
    scopeKeys.push(scopeKey);
  };

  for (const cortex of cortices) {
    const scopedSurfaces = Array.isArray(cortex?.directActionSurfaceScopes)
      ? cortex.directActionSurfaceScopes
      : [];
    for (const surface of scopedSurfaces) {
      if (typeof surface === 'string') {
        addScope(surface);
      } else if (surface && typeof surface === 'object') {
        addScope(surface.scopeKey || surface.scope_key || surface.intent_scope);
      }
    }
  }

  return scopeKeys;
}

function shouldDeferMainResponse({ activatedCortices, directActionScopeKeys } = {}) {
  if (isEnvDisabled('VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED')) {
    return false;
  }

  if (!Array.isArray(activatedCortices) || activatedCortices.length === 0) {
    return false;
  }

  const holdScopeKeys = collectConfiguredHoldScopeKeys(activatedCortices);
  if (holdScopeKeys.length === 0) {
    return false;
  }

  const directScopes = new Set(
    (Array.isArray(directActionScopeKeys) && directActionScopeKeys.length > 0
      ? directActionScopeKeys
      : collectDirectActionScopeKeysFromCortices(activatedCortices)
    )
      .map((scopeKey) => String(scopeKey || '').trim())
      .filter(Boolean),
  );

  const hasMainDirectOwnerForActivatedScope = holdScopeKeys.some((scopeKey) =>
    directScopes.has(scopeKey),
  );
  return !hasMainDirectOwnerForActivatedScope;
}

function stableStringHash(input) {
  const str = String(input || '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function loadHoldTextsFromEnv() {
  const fixed = (process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXT || '').trim();
  if (fixed) {
    return [fixed];
  }

  const json = (process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON || '').trim();
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter(Boolean);
        if (cleaned.length > 0) {
          return cleaned;
        }
      }
    } catch {
      // ignore invalid JSON; fall back to defaults
    }
  }

  return [];
}

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  if (text.length < 2) {
    return text;
  }
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function extractHoldTextsFromInstructions(instructions) {
  const src = typeof instructions === 'string' ? instructions : '';
  if (!src.trim()) {
    return [];
  }

  const lines = src.split(/\r?\n/);
  const headerRe = /\bholding\s+examples?\b/i;
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return [];
  }

  const texts = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = String(raw || '').trim();
    if (!line) {
      if (texts.length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith('#')) {
      break;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (!bullet) {
      if (texts.length > 0) {
        break;
      }
      continue;
    }
    const candidate = stripWrappingQuotes(bullet[1]);
    if (candidate) {
      texts.push(candidate);
    }
  }

  // De-duplicate while preserving order.
  const seen = new Set();
  return texts.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveConfiguredHoldTexts({ agentInstructions } = {}) {
  const configured = loadHoldTextsFromEnv();
  if (configured.length > 0) {
    return configured;
  }
  return extractHoldTextsFromInstructions(agentInstructions);
}

function pickHoldText({ responseMessageId, agentInstructions, scheduleId } = {}) {
  /* === VIVENTIUM NOTE ===
   * Feature: Silent hold for scheduler-triggered runs.
   * When a scheduled task triggers a tool cortex, no human is waiting for an acknowledgment.
   * Return {NTA} so the existing NTA suppression pipeline silences the hold message;
   * the Phase B follow-up with actual content still delivers normally.
   * === VIVENTIUM NOTE === */
  if (scheduleId) {
    return '{NTA}';
  }

  const texts = resolveConfiguredHoldTexts({ agentInstructions });

  if (texts.length === 0) {
    // Single minimal fallback (should rarely be used; prefer prompt-owned examples above).
    return 'Checking now.';
  }

  const idx = stableStringHash(responseMessageId) % texts.length;
  return texts[idx];
}

function shouldForcePhaseBFollowUp({
  shouldDeferMainResponse: deferred = false,
  parentText = '',
  hasInsights = false,
  hasMergedText = false,
  allowErrorOnlyFollowUp = false,
} = {}) {
  if (deferred === true) {
    return true;
  }

  if (!isNoResponseOnly(parentText)) {
    return false;
  }

  return hasInsights === true || hasMergedText === true || allowErrorOnlyFollowUp === true;
}

module.exports = {
  collectConfiguredHoldScopeKeys,
  collectDirectActionScopeKeysFromCortices,
  extractHoldTextsFromInstructions,
  isToolHoldCandidate,
  pickHoldText,
  resolveConfiguredHoldTexts,
  shouldForcePhaseBFollowUp,
  shouldDeferMainResponse,
};
