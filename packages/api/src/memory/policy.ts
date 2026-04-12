/* === VIVENTIUM START ===
 * Feature: Shared memory policy and deterministic maintenance
 *
 * Purpose:
 * - Keep UI memory edits and memory-agent writes under one shared policy.
 * - Prevent scheduler/tool operational residue from contaminating durable memory.
 * - Deterministically compact overgrown memory keys without deleting the recoverable
 *   detail that already lives in conversation history and artifacts.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

import { Tokenizer } from '~/utils';

export type MemoryEntryLike = {
  key: string;
  value: string;
  tokenCount?: number;
  updated_at?: Date | string | null;
};

export type MemoryKeyLimits = Record<string, number>;

export interface MemoryPolicyConfig {
  tokenLimit?: number | null;
  keyLimits?: MemoryKeyLimits | null;
  maintenanceThresholdPercent?: number | null;
  validKeys?: string[];
}

export interface MemoryWriteEvaluation {
  ok: boolean;
  errorType?: string;
  message?: string;
  blockedPattern?: string;
  details?: Record<string, unknown>;
}

export interface MemoryMaintenanceUpdate {
  key: string;
  value: string;
  tokenCount: number;
  previousTokenCount: number;
  reason: string;
}

export interface MemoryMaintenancePlan {
  shouldApply: boolean;
  reason: string[];
  updates: MemoryMaintenanceUpdate[];
  totalTokensBefore: number;
  totalTokensAfter: number;
}

export const DEFAULT_MEMORY_MAINTENANCE_THRESHOLD_PERCENT = 80;

export const DEFAULT_VIVENTIUM_MEMORY_KEY_LIMITS: MemoryKeyLimits = Object.freeze({
  core: 800,
  preferences: 600,
  world: 1200,
  context: 1200,
  moments: 1200,
  me: 600,
  working: 400,
  signals: 1000,
  drafts: 1000,
});

const DATE_ONLY_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const URL_RE = /https?:\/\/\S+/gi;
const OPERATIONAL_WORKING_SPLIT_RE =
  /\b(?:repeated internal checks?|wake loops?|self-reflection brews?|tool auth errors?|no new data)\b|\{NTA\}/i;
const NOISE_PATTERNS: RegExp[] = [
  /\{NTA\}/i,
  /\bwake loops?\b/i,
  /\binternal checks?\b/i,
  /\bself-reflection brews?\b/i,
  /\btool auth errors?\b/i,
  /\bschedule_list\b/i,
  /\buser_id missing\b/i,
  /\bno live ms365 access\b/i,
  /\bms365 no access\b/i,
  /\bmorning briefings repeated\b/i,
  /\bquiet state\b/i,
  /\bidentical loops?\b/i,
];
const EXISTING_MEMORY_NOISE_PATTERNS: RegExp[] = [...NOISE_PATTERNS, /\brepeated checks?\b/i];

const TODAY_TOKEN_ENCODING = 'o200k_base';
const WORLD_PRECOMPACT_THRESHOLD_PERCENT = 85;
const CONTEXT_EXPIRY_DAYS = 7;
const WORKING_STALE_AFTER_DAYS = 1;
const WORKING_EXPIRY_DAYS = 3;
const STALE_IN_PROGRESS_DRAFT_ARCHIVE_DAYS = 14;
const NOISY_SEMICOLON_RUN_RE = /(?:\s*;\s*){2,}/g;
const NOISY_SEMICOLON_RUN_TEST_RE = /(?:\s*;\s*){2,}/;
const WORLD_TEMPORAL_MARKERS: RegExp[] = [
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b/i,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:[a-z]+)?\b/i,
  /\b(?:today|tomorrow|yesterday|tonight|weekend|this week|next week|next month)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i,
  /\b(?:AM|PM)\s*(?:ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT|UTC)\b/i,
];
const WORLD_TRANSIENT_STATE_PATTERNS: RegExp[] = [
  /\b(?:pending|scheduled|rescheduled|delayed|blocked|stalled|paused|waiting)\b/i,
  /\b(?:deadline|eta|next step|follow-?up|reply state|outreach|intro(?:duction)?|prospective)\b/i,
  /\b(?:call|meeting|demo|pitch|check-?in|sync)\b/i,
  /\b(?:phase\d*|pilot|rollout|launch(?:ed)?|go-?live|prod(?:uction)?|deployment|migration|setup)\b/i,
  /\b(?:pricing|quote|proposal|invoice|payment|paid|equity|term sheet|sow|contract draft)\b/i,
  /\b(?:ordered|shipped|delivery|recently requested|gift|purchase|bought)\b/i,
];
const WORLD_CONTACT_LOGISTICS_PATTERNS: RegExp[] = [
  /@/,
  /\b(?:email|phone|cell|telegram|whatsapp|slack|discord|zoom|teams)\b/i,
];
const WORLD_DROP_PATTERNS: RegExp[] = [
  ...WORLD_TEMPORAL_MARKERS,
  ...WORLD_TRANSIENT_STATE_PATTERNS,
  ...WORLD_CONTACT_LOGISTICS_PATTERNS,
  /\$\d/i,
];
const WORLD_KEEP_PATTERNS: RegExp[] = [
  /\bmet\b/i,
  /\bmarried\b/i,
  /\bbirthday(?:\s*[:|-]|\s+is|\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:[a-z]+)?(?:\s+\d{1,2})?)\b/i,
  /\bwife\b/i,
  /\bdog\b/i,
  /\bfamily\b/i,
  /\bfather\b/i,
  /\bmother\b/i,
  /\bsister\b/i,
  /\bparents\b/i,
  /\bco-founded\b/i,
  /\bco-founder\b/i,
  /\bdecision intelligence\b/i,
  /\bvoice-first\b/i,
  /\bvision\b/i,
  /\bDelaware\b/i,
  /\bpowered by\b/i,
  /\bflagship client\b/i,
  /\bchampion\b/i,
  /\badvisors?\b/i,
  /\bdirector of\b/i,
  /\blawyer\b/i,
  /\btherapist\b/i,
  /\bCIO\b/i,
  /\bCEO\b/i,
  /\bCSO\b/i,
  /\badvisor\b/i,
  /\bflagship\b/i,
  /\bpartner\b/i,
];

type DraftRecord = {
  thread: string;
  status?: string;
  started?: string;
  lastWorked?: string;
  archived?: boolean;
  archiveSummary?: string;
  direction?: string;
  next?: string;
  notes: string[];
  nextSteps: string[];
};

type SignalRecord = {
  domain: string;
  observation?: string;
  confidence?: string;
  firstSeen?: string;
  lastSeen?: string;
  evidence: string[];
  watchFor: string[];
};

export function resolveMemoryKeyLimits(
  keyLimits?: MemoryKeyLimits | null,
): MemoryKeyLimits | undefined {
  if (!keyLimits || typeof keyLimits !== 'object') {
    return undefined;
  }

  const resolved = Object.entries(keyLimits).reduce((acc, [key, value]) => {
    const parsed = Number(value);
    if (key && Number.isFinite(parsed) && parsed > 0) {
      acc[key] = Math.round(parsed);
    }
    return acc;
  }, {} as MemoryKeyLimits);

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveMaintenanceThresholdPercent(value?: number | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MEMORY_MAINTENANCE_THRESHOLD_PERCENT;
  }
  return Math.min(100, Math.max(1, Math.round(parsed)));
}

export function containsOperationalNoise(value?: string, useExistingPatterns = false): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  const patterns = useExistingPatterns ? EXISTING_MEMORY_NOISE_PATTERNS : NOISE_PATTERNS;
  return patterns.some((pattern) => pattern.test(value));
}

export function evaluateMemoryWrite({
  key,
  value,
  tokenCount,
  validKeys,
  tokenLimit,
  keyLimits,
  baselineTotalTokens = 0,
  previousTokenCount = 0,
}: {
  key: string;
  value: string;
  tokenCount: number;
  validKeys?: string[];
  tokenLimit?: number | null;
  keyLimits?: MemoryKeyLimits;
  baselineTotalTokens?: number;
  previousTokenCount?: number;
}): MemoryWriteEvaluation {
  if (validKeys && validKeys.length > 0 && !validKeys.includes(key)) {
    return {
      ok: false,
      errorType: 'invalid_key',
      message: `Invalid key "${key}". Must be one of: ${validKeys.join(', ')}`,
      details: { key, validKeys },
    };
  }

  const blockedPattern = getBlockedPattern(value);
  if (blockedPattern) {
    return {
      ok: false,
      errorType: 'noise_rejected',
      blockedPattern,
      message:
        'Memory value contains scheduler or tool operational residue. Store the durable user fact or project state instead.',
      details: { key, blockedPattern },
    };
  }

  const safePreviousTokens = sanitizeTokenCount(previousTokenCount);
  const safeBaselineTotalTokens = sanitizeTokenCount(baselineTotalTokens);
  const tokenDelta = tokenCount - safePreviousTokens;
  const projectedTotalTokens = safeBaselineTotalTokens + tokenDelta;
  const resolvedTokenLimit =
    tokenLimit != null && Number.isFinite(Number(tokenLimit)) ? Number(tokenLimit) : null;

  if (resolvedTokenLimit != null && tokenDelta > 0) {
    if (safeBaselineTotalTokens > resolvedTokenLimit) {
      return {
        ok: false,
        errorType: 'already_exceeded',
        message: 'Memory storage exceeded. Reduce existing memory before adding more.',
        details: {
          tokenLimit: resolvedTokenLimit,
          totalTokens: safeBaselineTotalTokens,
          projectedTotalTokens,
        },
      };
    }

    if (projectedTotalTokens > resolvedTokenLimit) {
      return {
        ok: false,
        errorType: 'would_exceed',
        message: 'Memory storage would exceed the configured token limit.',
        details: {
          tokenLimit: resolvedTokenLimit,
          totalTokens: safeBaselineTotalTokens,
          projectedTotalTokens,
          tokenDelta,
        },
      };
    }
  }

  const resolvedKeyLimits = resolveMemoryKeyLimits(keyLimits);
  const keyLimit = resolvedKeyLimits?.[key];
  if (keyLimit != null) {
    const projectedKeyTokens = tokenCount;
    const keyIsAlreadyOverLimit = safePreviousTokens > keyLimit;

    if (!keyIsAlreadyOverLimit && projectedKeyTokens > keyLimit) {
      return {
        ok: false,
        errorType: 'key_limit_exceeded',
        message: `Memory key "${key}" would exceed its ${keyLimit}-token budget.`,
        details: {
          key,
          keyLimit,
          previousTokenCount: safePreviousTokens,
          projectedKeyTokens,
        },
      };
    }

    if (keyIsAlreadyOverLimit && projectedKeyTokens >= safePreviousTokens) {
      return {
        ok: false,
        errorType: 'key_already_exceeded',
        message: `Memory key "${key}" is already above its ${keyLimit}-token budget. Reduce it before growing it again.`,
        details: {
          key,
          keyLimit,
          previousTokenCount: safePreviousTokens,
          projectedKeyTokens,
        },
      };
    }
  }

  return {
    ok: true,
    details: {
      tokenDelta,
      projectedTotalTokens,
      projectedKeyTokens: tokenCount,
    },
  };
}

export function createMemoryMaintenancePlan({
  memories,
  policy,
  now = new Date(),
}: {
  memories: MemoryEntryLike[];
  policy: MemoryPolicyConfig;
  now?: Date;
}): MemoryMaintenancePlan {
  const memoryMap = new Map<string, MemoryEntryLike>();
  for (const memory of memories) {
    if (memory?.key) {
      memoryMap.set(memory.key, { ...memory, tokenCount: sanitizeTokenCount(memory.tokenCount) });
    }
  }

  const tokenLimit =
    policy.tokenLimit != null && Number.isFinite(Number(policy.tokenLimit))
      ? Number(policy.tokenLimit)
      : null;
  const keyLimits = resolveMemoryKeyLimits(policy.keyLimits);
  const thresholdPercent = resolveMaintenanceThresholdPercent(policy.maintenanceThresholdPercent);
  const totalTokensBefore = getTotalTokens(Array.from(memoryMap.values()));
  const thresholdTokens =
    tokenLimit != null
      ? Math.floor((tokenLimit * thresholdPercent) / 100)
      : Number.POSITIVE_INFINITY;
  const needsThresholdRelief = tokenLimit != null && totalTokensBefore >= thresholdTokens;
  const hasNoise = Array.from(memoryMap.values()).some((memory) =>
    containsOperationalNoise(memory.value, true),
  );
  const hasSeparatorCorruption = Array.from(memoryMap.values()).some((memory) =>
    containsSeparatorCorruption(memory.value),
  );
  const hasExpiredContext = hasExpiredContextSnapshot(memoryMap.get('context')?.value, now);
  const hasExpiredWorking = hasExpiredWorkingSnapshot(memoryMap.get('working')?.value, now);
  const hasStaleActiveDrafts = hasLongIdleActiveDrafts(memoryMap.get('drafts')?.value, now);
  const keysOverLimit =
    keyLimits == null
      ? []
      : Array.from(memoryMap.values())
          .filter((memory) => {
            const keyLimit = keyLimits[memory.key];
            return keyLimit != null && sanitizeTokenCount(memory.tokenCount) > keyLimit;
          })
          .map((memory) => memory.key);
  const keysNearLimit =
    keyLimits == null
      ? []
      : Array.from(memoryMap.values())
          .filter((memory) => {
            const keyLimit = keyLimits[memory.key];
            if (keyLimit == null) {
              return false;
            }
            const pressureThreshold = Math.floor((keyLimit * thresholdPercent) / 100);
            const tokens = sanitizeTokenCount(memory.tokenCount);
            return tokens >= pressureThreshold && tokens <= keyLimit;
          })
          .map((memory) => memory.key);

  if (
    !needsThresholdRelief &&
    !hasNoise &&
    !hasSeparatorCorruption &&
    !hasExpiredContext &&
    !hasExpiredWorking &&
    !hasStaleActiveDrafts &&
    keysOverLimit.length === 0 &&
    keysNearLimit.length === 0
  ) {
    return {
      shouldApply: false,
      reason: [],
      updates: [],
      totalTokensBefore,
      totalTokensAfter: totalTokensBefore,
    };
  }

  const reason: string[] = [];
  if (needsThresholdRelief) {
    reason.push(
      `total usage ${totalTokensBefore} reached maintenance threshold ${thresholdTokens}`,
    );
  }
  if (hasNoise) {
    reason.push('existing memories contain scheduler or tool residue');
  }
  if (hasSeparatorCorruption) {
    reason.push('existing memories contain repeated separator corruption');
  }
  if (hasExpiredContext) {
    reason.push('context expired and needs refresh');
  }
  if (hasExpiredWorking) {
    reason.push('working snapshot is stale or expired');
  }
  if (hasStaleActiveDrafts) {
    reason.push('drafts contain long-idle active work');
  }
  if (keysOverLimit.length > 0) {
    reason.push(`keys over budget: ${keysOverLimit.join(', ')}`);
  }
  if (keysNearLimit.length > 0) {
    reason.push(`keys at maintenance threshold: ${keysNearLimit.join(', ')}`);
  }

  applyTransform(
    memoryMap,
    'me',
    'Removed operational residue from relationship observations',
    (entry) => compactMeValue(entry.value, keyLimits?.me, now),
  );
  applyTransform(
    memoryMap,
    'signals',
    'Pruned operational residue and overlong evidence from signals',
    (entry) => compactSignalsValue(entry.value, now, keyLimits?.signals),
  );
  applyTransform(memoryMap, 'drafts', 'Compressed drafts into a compact project index', (entry) =>
    compactDraftsValue(entry.value, now, keyLimits?.drafts),
  );
  applyTransform(
    memoryMap,
    'world',
    'Compacted world to durable relationships and venture identity',
    (entry) => compactWorldValue(entry.value, now, keyLimits?.world),
  );
  applyTransform(
    memoryMap,
    'context',
    'Trimmed context to active state and removed operational chatter',
    (entry) => compactContextValue(entry.value, now, keyLimits?.context),
  );
  applyTransform(memoryMap, 'working', 'Compacted stale working memory snapshot', (entry) =>
    compactWorkingValue(entry.value, now, keyLimits?.working),
  );
  applyTransform(memoryMap, 'moments', 'Pruned moments to the active episodic window', (entry) =>
    compactMomentsValue(entry.value, now, keyLimits?.moments),
  );

  const updates: MemoryMaintenanceUpdate[] = [];
  for (const memory of memories) {
    const next = memoryMap.get(memory.key);
    if (!next || normalizeComparisonText(next.value) === normalizeComparisonText(memory.value)) {
      continue;
    }
    updates.push({
      key: memory.key,
      value: next.value,
      tokenCount: countTokens(next.value),
      previousTokenCount: sanitizeTokenCount(memory.tokenCount),
      reason: nextReason(memory.key),
    });
  }

  const totalTokensAfter = getTotalTokens(Array.from(memoryMap.values()));

  return {
    shouldApply: updates.length > 0,
    reason,
    updates,
    totalTokensBefore,
    totalTokensAfter,
  };
}

export async function runMemoryMaintenance({
  userId,
  getAllUserMemories,
  setMemory,
  policy,
  now = new Date(),
}: {
  userId: string;
  getAllUserMemories: (userId: string) => Promise<MemoryEntryLike[]>;
  setMemory: (params: {
    userId: string;
    key: string;
    value: string;
    tokenCount: number;
  }) => Promise<{ ok: boolean }>;
  policy: MemoryPolicyConfig;
  now?: Date;
}): Promise<MemoryMaintenancePlan> {
  const memories = await getAllUserMemories(userId);
  const plan = createMemoryMaintenancePlan({ memories, policy, now });

  if (!plan.shouldApply) {
    return plan;
  }

  for (const update of plan.updates) {
    await setMemory({
      userId,
      key: update.key,
      value: update.value,
      tokenCount: update.tokenCount,
    });
  }

  return plan;
}

function nextReason(key: string): string {
  switch (key) {
    case 'me':
      return 'Removed operational residue from relationship observations';
    case 'signals':
      return 'Pruned operational residue and overlong evidence from signals';
    case 'drafts':
      return 'Compressed drafts into a compact project index';
    case 'world':
      return 'Compacted world to durable relationships and venture identity';
    case 'context':
      return 'Trimmed context to active state and removed operational chatter';
    case 'working':
      return 'Compacted stale working memory snapshot';
    case 'moments':
      return 'Pruned moments to the active episodic window';
    default:
      return 'Applied deterministic memory maintenance';
  }
}

function applyTransform(
  memoryMap: Map<string, MemoryEntryLike>,
  key: string,
  _reason: string,
  transform: (entry: MemoryEntryLike) => string,
): void {
  const entry = memoryMap.get(key);
  if (!entry || typeof entry.value !== 'string' || entry.value.trim().length === 0) {
    return;
  }

  const nextValue = transform(entry);
  if (normalizeComparisonText(nextValue) === normalizeComparisonText(entry.value)) {
    return;
  }

  memoryMap.set(key, {
    ...entry,
    value: nextValue,
    tokenCount: countTokens(nextValue),
  });
}

function compactMeValue(value: string, keyLimit?: number, now = new Date()): string {
  const sections = new Map<string, string[]>();
  let currentSection = "What I've noticed:";
  sections.set(currentSection, []);

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (isMarkerLine(line)) {
      continue;
    }
    if (/^[A-Za-z].*:$/.test(line)) {
      currentSection = line;
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }
    if (line.startsWith('- ') && !matchesNoiseLine(line)) {
      const bucket = sections.get(currentSection) ?? [];
      const compact = compactSentence(line.slice(2), 28);
      if (compact) {
        bucket.push(`- ${compact}`);
        sections.set(currentSection, dedupeLines(bucket));
      }
    }
  }

  const headingOrder = Array.from(sections.keys());
  const notices = sections.get("What I've noticed:") ?? [];
  const whatWorks = sections.get('What works:') ?? [];
  let noticeLimit = notices.length;
  let worksLimit = whatWorks.length;

  let candidate = buildMeValue(headingOrder, sections, noticeLimit, worksLimit, now);
  while (
    keyLimit != null &&
    countTokens(candidate) > keyLimit &&
    (noticeLimit > 8 || worksLimit > 4)
  ) {
    if (noticeLimit > 8) {
      noticeLimit -= 1;
    } else if (worksLimit > 4) {
      worksLimit -= 1;
    } else {
      break;
    }
    candidate = buildMeValue(headingOrder, sections, noticeLimit, worksLimit, now);
  }

  return candidate;
}

function buildMeValue(
  headingOrder: string[],
  sections: Map<string, string[]>,
  noticeLimit: number,
  worksLimit: number,
  now: Date,
): string {
  const lines: string[] = [];
  for (const heading of headingOrder) {
    const items = sections.get(heading) ?? [];
    let effectiveItems = items;
    if (heading === "What I've noticed:") {
      effectiveItems = items.slice(0, noticeLimit);
    } else if (heading === 'What works:') {
      effectiveItems = items.slice(0, worksLimit);
    }
    if (effectiveItems.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(heading);
    lines.push(...effectiveItems);
  }
  lines.push(`_updated: ${formatDateOnly(now)}`);
  return lines.join('\n').trim();
}

function compactSignalsValue(value: string, now: Date, keyLimit?: number): string {
  const records = parseSignals(value)
    .filter((record) => !containsOperationalNoise(record.domain, true))
    .filter((record) => !containsOperationalNoise(record.observation, true))
    .filter((record) => !record.domain.toLowerCase().includes('wake_loop'));

  let evidenceCount = 3;
  let observationWords = 26;
  let evidenceWords = 16;

  let candidate = buildSignalsValue(records, now, observationWords, evidenceCount, evidenceWords);
  while (
    keyLimit != null &&
    countTokens(candidate) > keyLimit &&
    (evidenceCount > 1 || observationWords > 16 || evidenceWords > 10)
  ) {
    if (evidenceCount > 1) {
      evidenceCount -= 1;
    } else if (observationWords > 16) {
      observationWords -= 2;
    } else if (evidenceWords > 10) {
      evidenceWords -= 2;
    } else {
      break;
    }
    candidate = buildSignalsValue(records, now, observationWords, evidenceCount, evidenceWords);
  }

  return candidate;
}

function buildSignalsValue(
  records: SignalRecord[],
  now: Date,
  observationWords: number,
  evidenceCount: number,
  evidenceWords: number,
): string {
  const lines: string[] = [];
  for (const record of records) {
    lines.push(`- domain: ${record.domain}`);
    if (record.observation) {
      lines.push(`  observation: "${compactSentence(record.observation, observationWords)}"`);
    }
    const confidenceBits = [
      record.confidence ? `confidence: ${record.confidence}` : null,
      record.firstSeen ? `first_seen: ${record.firstSeen}` : null,
      record.lastSeen ? `last_seen: ${record.lastSeen}` : null,
    ].filter(Boolean);
    if (confidenceBits.length > 0) {
      lines.push(`  ${confidenceBits.join(' | ')}`);
    }
    const evidence = record.evidence
      .filter((item) => !matchesNoiseLine(item))
      .slice(0, evidenceCount)
      .map((item) => `    - "${compactSentence(item, evidenceWords)}"`);
    if (evidence.length > 0) {
      lines.push('  evidence:');
      lines.push(...evidence);
    }
    const watchFor = record.watchFor
      .slice(0, 2)
      .map((item) => `    - "${compactSentence(item, 12)}"`);
    if (watchFor.length > 0) {
      lines.push('  watch_for:');
      lines.push(...watchFor);
    }
    lines.push('');
  }
  lines.push(`_updated: ${formatDateOnly(now)}`);
  return lines.join('\n').trim();
}

function compactDraftsValue(value: string, now: Date, keyLimit?: number): string {
  const records = parseDrafts(value);
  let summaryWords = 18;
  let nextWords = 12;

  let candidate = buildDraftsValue(records, now, summaryWords, nextWords);
  while (
    keyLimit != null &&
    countTokens(candidate) > keyLimit &&
    (summaryWords > 10 || nextWords > 8)
  ) {
    if (summaryWords > 10) {
      summaryWords -= 2;
    } else if (nextWords > 8) {
      nextWords -= 1;
    } else {
      break;
    }
    candidate = buildDraftsValue(records, now, summaryWords, nextWords);
  }

  return candidate;
}

function buildDraftsValue(
  records: DraftRecord[],
  now: Date,
  summaryWords: number,
  nextWords: number,
): string {
  const active: string[] = [];
  const archived: string[] = [];

  for (const record of records) {
    const summarySource = record.direction || record.notes.join('; ');
    const nextSource = record.next || record.nextSteps.join('; ');
    const compactSummary =
      compactSentence(summarySource, summaryWords) || 'See conversation history.';
    const compactNext = compactSentence(nextSource, nextWords) || 'Review conversation history.';
    const lastWorked = record.lastWorked || record.started || 'unknown';
    if (record.archived) {
      const archivedSummary =
        compactSentence(record.archiveSummary || `${record.thread}: ${summarySource || nextSource || record.status || 'done'}`, 16) ||
        `${record.thread}: ${record.status || 'done'}`;
      archived.push(
        `- ${record.thread} | ${record.status || 'done'} | last_worked: ${lastWorked} | ${archivedSummary}`,
      );
      continue;
    }
    const archivedThread =
      isArchiveableDraft(record, now) &&
      compactSentence(
        `${record.thread}: ${summarySource || nextSource || record.status || 'done'}`,
        16,
      );

    if (archivedThread) {
      archived.push(
        `- ${record.thread} | ${record.status || 'done'} | last_worked: ${lastWorked} | ${archivedThread}`,
      );
      continue;
    }

    active.push(
      `- thread: ${record.thread} | status: ${record.status || 'in_progress'} | last_worked: ${lastWorked}`,
    );
    active.push(`  summary: "${compactSummary}"`);
    active.push(`  next: ${compactNext}`);
    active.push('');
  }

  const lines: string[] = [];
  lines.push(...active.filter((line, index, source) => !(line === '' && source[index - 1] === '')));
  if (archived.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push('Archived:');
    lines.push(...archived);
  }
  lines.push(`_updated: ${formatDateOnly(now)}`);
  return lines.join('\n').trim();
}

export function prepareMemoryValueForWrite({
  key,
  value,
  keyLimits,
  thresholdPercent = WORLD_PRECOMPACT_THRESHOLD_PERCENT,
  now = new Date(),
}: {
  key: string;
  value: string;
  keyLimits?: MemoryKeyLimits | null;
  thresholdPercent?: number;
  now?: Date;
}): { value: string; tokenCount: number; compacted: boolean } {
  const trimmed = typeof value === 'string' ? collapseSeparatorNoise(value).trim() : '';
  if (!trimmed) {
    return { value: '', tokenCount: 0, compacted: false };
  }

  const resolvedKeyLimits = resolveMemoryKeyLimits(keyLimits);
  const keyLimit = resolvedKeyLimits?.[key];
  let nextValue = trimmed;

  if (key === 'world' && keyLimit != null) {
    const pressureThreshold = Math.floor((keyLimit * thresholdPercent) / 100);
    const tokenCount = countTokens(trimmed);
    if (tokenCount >= pressureThreshold || containsWorldTemporalResidue(trimmed)) {
      nextValue = compactWorldValue(trimmed, now, keyLimit);
    }
  }

  return {
    value: nextValue,
    tokenCount: countTokens(nextValue),
    compacted: normalizeText(nextValue) !== normalizeText(trimmed),
  };
}

export function compactWorldValue(value: string, now: Date, keyLimit?: number): string {
  let relationshipWords = 48;
  let ventureWords = 42;
  let peopleLimit = 18;
  let peopleWords = 8;
  let candidate = buildWorldValue(
    value,
    now,
    relationshipWords,
    ventureWords,
    peopleLimit,
    peopleWords,
  );

  while (
    keyLimit != null &&
    countTokens(candidate) > keyLimit &&
    (relationshipWords > 28 || ventureWords > 24 || peopleLimit > 12 || peopleWords > 5)
  ) {
    if (peopleLimit > 12) {
      peopleLimit -= 2;
    } else if (ventureWords > 24) {
      ventureWords -= 3;
    } else if (relationshipWords > 28) {
      relationshipWords -= 2;
    } else if (peopleWords > 5) {
      peopleWords -= 1;
    } else {
      break;
    }
    candidate = buildWorldValue(
      value,
      now,
      relationshipWords,
      ventureWords,
      peopleLimit,
      peopleWords,
    );
  }

  if (keyLimit != null && countTokens(candidate) > keyLimit) {
    candidate = buildWorldValue(value, now, 18, 16, 10, 5);
  }
  if (keyLimit != null && countTokens(candidate) > keyLimit) {
    candidate = buildWorldValue(value, now, 14, 10, 0, 0);
  }
  if (keyLimit != null && countTokens(candidate) > keyLimit) {
    candidate = trimWorldCandidateToLimit(candidate, keyLimit);
  }

  return candidate;
}

function buildWorldValue(
  value: string,
  now: Date,
  relationshipWords: number,
  ventureWords: number,
  peopleLimit: number,
  peopleWords: number,
): string {
  const lines: string[] = [];

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isMarkerLine(line)) {
      continue;
    }
    if (line === 'Ventures:') {
      if (lines[lines.length - 1] !== 'Ventures:') {
        lines.push('Ventures:');
      }
      continue;
    }
    if (/^Key people:/i.test(line)) {
      const compactedPeople = compactWorldPeopleLine(line, peopleLimit, peopleWords);
      if (compactedPeople) {
        lines.push(compactedPeople);
      }
      continue;
    }

    const compacted = line.startsWith('- ')
      ? compactWorldEntry(line, ventureWords)
      : compactWorldEntry(line, relationshipWords);
    if (compacted) {
      lines.push(compacted);
    }
  }

  lines.push(`_updated: ${formatDateOnly(now)}`);
  return lines.join('\n').trim();
}

function compactContextValue(value: string, now: Date, keyLimit?: number): string {
  let trackWords = 85;
  let openLoopCount = 20;
  let candidate = buildContextValue(value, now, trackWords, openLoopCount);

  while (
    keyLimit != null &&
    countTokens(candidate) > keyLimit &&
    (trackWords > 40 || openLoopCount > 10)
  ) {
    if (trackWords > 40) {
      trackWords -= 5;
    } else if (openLoopCount > 10) {
      openLoopCount -= 2;
    } else {
      break;
    }
    candidate = buildContextValue(value, now, trackWords, openLoopCount);
  }

  return candidate;
}

function buildContextValue(
  value: string,
  now: Date,
  trackWords: number,
  openLoopCount: number,
): string {
  const updated = formatDateOnly(now);
  const expires = addDays(updated, CONTEXT_EXPIRY_DAYS);
  const lines: string[] = [];

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isMarkerLine(line)) {
      continue;
    }
    if (matchesNoiseLine(line) || /repeated checks?|no new data/i.test(line)) {
      continue;
    }
    if (line === 'Priority tracks:') {
      lines.push(line);
      continue;
    }
    if (/^- Track\d+ .*:/.test(line) || /^- Life:/.test(line)) {
      lines.push(compactKeyedLine(line, trackWords));
      continue;
    }
    if (/^Open loops:/.test(line)) {
      lines.push(compactOpenLoops(line, openLoopCount));
      continue;
    }
    if (/^Weekend reset done\./.test(line)) {
      lines.push('Weekend reset done.');
      continue;
    }
    lines.push(compactSentence(line, 28));
  }

  lines.push(`_updated: ${updated}`);
  lines.push(`_expires: ${expires}`);
  return lines.join('\n').trim();
}

function compactWorkingValue(value: string, now: Date, keyLimit?: number): string {
  const isExpired = isDateMarkerBefore(value, '_expires', now);
  const isStale = isDateMarkerBefore(value, '_stale_after', now);
  const hasOperationalNoise =
    containsOperationalNoise(value, true) || /\bno new data\b/i.test(value);
  if (
    !isExpired &&
    !isStale &&
    !hasOperationalNoise &&
    (keyLimit == null || countTokens(value) <= keyLimit)
  ) {
    return value.trim();
  }
  const body = value
    .split(/\r?\n/)
    .filter((line) => !isMarkerLine(line.trim()))
    .join(' ')
    .trim();
  const preferredBody =
    hasOperationalNoise && OPERATIONAL_WORKING_SPLIT_RE.test(body)
      ? body.split(OPERATIONAL_WORKING_SPLIT_RE)[0].trim()
      : body;
  const compactBody = compactSentence(
    preferredBody || body,
    isExpired || isStale || hasOperationalNoise ? 32 : 60,
  );

  if (!compactBody) {
    return value.trim();
  }

  const updated = formatDateOnly(now);
  const staleAfter = addDays(updated, WORKING_STALE_AFTER_DAYS);
  const expires = addDays(updated, WORKING_EXPIRY_DAYS);
  let candidate = `${compactBody}\n_updated: ${updated} | _stale_after: ${staleAfter} | _expires: ${expires}`;

  if (keyLimit != null && countTokens(candidate) > keyLimit) {
    candidate = `${compactSentence(preferredBody || body, 40)}\n_updated: ${updated} | _stale_after: ${staleAfter} | _expires: ${expires}`;
  }
  return candidate.trim();
}

function compactMomentsValue(value: string, now: Date, keyLimit?: number): string {
  const entries = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isMarkerLine(line))
    .slice(-12);

  let keptEntries = entries;
  let candidate = `${keptEntries.join('\n')}\n_updated: ${formatDateOnly(now)}`.trim();
  while (keyLimit != null && countTokens(candidate) > keyLimit && keptEntries.length > 8) {
    keptEntries = keptEntries.slice(1);
    candidate = `${keptEntries.join('\n')}\n_updated: ${formatDateOnly(now)}`.trim();
  }
  return candidate;
}

function compactWorldEntry(line: string, wordLimit: number): string {
  const prefix = line.startsWith('- ') ? '- ' : '';
  const body = prefix ? line.slice(2).trim() : line.trim();
  if (!body) {
    return '';
  }

  const compacted = buildWorldEntryBody(body, wordLimit);
  if (!compacted) {
    return '';
  }

  return `${prefix}${compacted}`.trim();
}

function buildWorldEntryBody(body: string, wordLimit: number): string {
  const [label, content] = splitLabel(body);
  const rawClauses = splitWorldClauses(content);
  const keptClauses = dedupeLines(
    rawClauses
      .map((clause) => sanitizeWorldClause(clause))
      .filter(Boolean)
      .filter((clause) => !shouldDropWorldClause(clause)),
  );

  if (keptClauses.length === 0) {
    return '';
  }

  const compactedContent = compactWorldClauses(keptClauses, wordLimit);
  if (!compactedContent) {
    return '';
  }

  return label ? `${label}: ${compactedContent}` : compactedContent;
}

function compactWorldPeopleLine(line: string, peopleLimit: number, wordLimit: number): string {
  const [label, content] = splitLabel(line);
  if (!label) {
    return compactWorldEntry(line, Math.max(peopleLimit * wordLimit, 18));
  }

  const people = dedupeLines(
    splitTopLevelList(content)
      .map((entry) => sanitizeWorldClause(entry))
      .filter(Boolean)
      .filter((entry) => !shouldDropWorldClause(entry)),
  )
    .slice(0, peopleLimit)
    .map((entry) => compactSentence(entry, wordLimit))
    .filter(Boolean);

  if (people.length === 0) {
    return '';
  }

  return `${label}: ${people.join(', ')}`;
}

function compactWorldClauses(clauses: string[], wordLimit: number): string {
  const accepted: string[] = [];
  let usedWords = 0;

  for (const rawClause of clauses) {
    const clause = sanitizeOperationalText(rawClause)
      .replace(/[,.;:-]+$/, '')
      .trim();
    if (!clause) {
      continue;
    }
    const clauseWords = clause.split(/\s+/).filter(Boolean);
    if (accepted.length > 0 && usedWords + clauseWords.length > wordLimit) {
      break;
    }
    if (clauseWords.length >= wordLimit && accepted.length === 0) {
      return truncateWords(clauseWords, wordLimit);
    }
    accepted.push(clause);
    usedWords += clauseWords.length;
    if (usedWords >= wordLimit) {
      break;
    }
  }

  if (accepted.length === 0) {
    return '';
  }

  return truncateWords(accepted.join('; ').split(/\s+/).filter(Boolean), wordLimit);
}

function parseDrafts(value: string): DraftRecord[] {
  const records: DraftRecord[] = [];
  let current: DraftRecord | null = null;
  let section: 'notes' | 'next_steps' | null = null;
  let inArchivedSection = false;

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isMarkerLine(line)) {
      continue;
    }
    if (line === 'Archived:') {
      if (current) {
        records.push(current);
        current = null;
      }
      section = null;
      inArchivedSection = true;
      continue;
    }
    if (line.startsWith('- thread: ')) {
      if (current) {
        records.push(current);
      }
      const threadLine = line.replace(/^- thread:\s*/, '').trim();
      current = {
        thread: threadLine.split(/\s+\|\s+status:/i)[0].trim(),
        notes: [],
        nextSteps: [],
      };
      current.status = threadLine.match(/\bstatus:\s*([^|]+)/i)?.[1]?.trim();
      current.lastWorked = threadLine.match(/\blast_worked:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
      section = null;
      inArchivedSection = false;
      continue;
    }
    if (inArchivedSection && line.startsWith('- ')) {
      const archivedMatch = line.match(/^- (.+?) \| ([^|]+) \| last_worked: ([^|]+) \| (.+)$/i);
      if (archivedMatch) {
        const [, thread, status, lastWorkedRaw, archiveSummary] = archivedMatch;
        records.push({
          thread: thread.trim(),
          status: status.trim(),
          lastWorked: lastWorkedRaw.trim() === 'unknown' ? undefined : lastWorkedRaw.trim(),
          archived: true,
          archiveSummary: archiveSummary.trim(),
          notes: [],
          nextSteps: [],
        });
      }
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('status: ')) {
      current.status = line.match(/^status:\s*([^|]+)/)?.[1]?.trim();
      current.started = line.match(/\bstarted:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      current.lastWorked = line.match(/\blast_worked:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      section = null;
      continue;
    }
    if (line.startsWith('direction: ')) {
      current.direction = stripOuterQuotes(line.replace(/^direction:\s*/, ''));
      section = null;
      continue;
    }
    if (line.startsWith('summary: ')) {
      current.direction = stripOuterQuotes(line.replace(/^summary:\s*/, ''));
      section = null;
      continue;
    }
    if (line === 'notes:') {
      section = 'notes';
      continue;
    }
    if (line === 'next_steps:') {
      section = 'next_steps';
      continue;
    }
    if (line.startsWith('next: ')) {
      current.next = stripOuterQuotes(line.replace(/^next:\s*/, ''));
      section = null;
      continue;
    }
    if (line.startsWith('- ') && section === 'notes') {
      current.notes.push(stripOuterQuotes(line.slice(2)));
      continue;
    }
    if (line.startsWith('- ') && section === 'next_steps') {
      current.nextSteps.push(stripOuterQuotes(line.slice(2)));
    }
  }

  if (current) {
    records.push(current);
  }

  return records;
}

function parseSignals(value: string): SignalRecord[] {
  const records: SignalRecord[] = [];
  let current: SignalRecord | null = null;
  let section: 'evidence' | 'watch_for' | null = null;

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isMarkerLine(line)) {
      continue;
    }
    if (line.startsWith('- domain: ')) {
      if (current) {
        records.push(current);
      }
      current = {
        domain: line.replace(/^- domain:\s*/, '').trim(),
        evidence: [],
        watchFor: [],
      };
      section = null;
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('observation: ')) {
      current.observation = stripOuterQuotes(line.replace(/^observation:\s*/, ''));
      section = null;
      continue;
    }
    if (line.startsWith('confidence: ')) {
      current.confidence = line.match(/^confidence:\s*([^|]+)/)?.[1]?.trim();
      current.firstSeen = line.match(/\bfirst_seen:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      current.lastSeen = line.match(/\blast_seen:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      section = null;
      continue;
    }
    if (line === 'evidence:') {
      section = 'evidence';
      continue;
    }
    if (line === 'watch_for:') {
      section = 'watch_for';
      continue;
    }
    if (line.startsWith('- ') && section === 'evidence') {
      current.evidence.push(stripOuterQuotes(line.slice(2)));
      continue;
    }
    if (line.startsWith('- ') && section === 'watch_for') {
      current.watchFor.push(stripOuterQuotes(line.slice(2)));
    }
  }

  if (current) {
    records.push(current);
  }

  return records;
}

function compactOpenLoops(line: string, limit: number): string {
  const [label, rawItems = ''] = line.split(':', 2);
  const items = dedupeLines(
    rawItems
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ).slice(0, limit);
  return `${label}: ${items.join(', ')}`;
}

function compactKeyedLine(line: string, wordLimit: number): string {
  const index = line.indexOf(':');
  if (index === -1) {
    return compactSentence(line, wordLimit);
  }
  const label = line.slice(0, index + 1);
  const content = line.slice(index + 1).trim();
  return `${label} ${compactSentence(content, wordLimit)}`.trim();
}

function compactSentence(value: string | undefined, wordLimit: number): string {
  const normalized = sanitizeOperationalText(value);
  if (!normalized) {
    return '';
  }

  const clauses = normalized
    .split(/(?<=[.;!?])\s+|\s+\|\s+|\s+->\s+|\s+=>\s+|\s+;\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const accepted: string[] = [];
  let usedWords = 0;
  for (const rawClause of clauses) {
    const clause = rawClause.replace(/[,.;:-]+$/, '').trim();
    if (!clause) {
      continue;
    }
    const clauseWords = clause.split(/\s+/).filter(Boolean);
    if (accepted.length > 0 && usedWords + clauseWords.length > wordLimit) {
      break;
    }
    if (clauseWords.length >= wordLimit && accepted.length === 0) {
      return truncateWords(clauseWords, wordLimit);
    }
    accepted.push(clause);
    usedWords += clauseWords.length;
    if (usedWords >= wordLimit) {
      break;
    }
  }

  if (accepted.length === 0) {
    return truncateWords(normalized.split(/\s+/).filter(Boolean), wordLimit);
  }

  const compact = accepted.join('; ');
  return truncateWords(compact.split(/\s+/).filter(Boolean), wordLimit);
}

function truncateWords(words: string[], wordLimit: number): string {
  if (words.length <= wordLimit) {
    return words.join(' ');
  }
  return `${words.slice(0, wordLimit).join(' ')}...`;
}

function collapseSeparatorNoise(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(NOISY_SEMICOLON_RUN_RE, '; '))
    .join('\n');
}

function normalizeText(value?: string): string {
  const normalized = normalizeComparisonText(value);
  if (!normalized) {
    return '';
  }
  return collapseSeparatorNoise(normalized);
}

function normalizeComparisonText(value?: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(URL_RE, '').replace(/\s+/g, ' ').trim();
}

function sanitizeOperationalText(value?: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  return normalized
    .replace(/\brepeated\s+quiet-state\s+wake loops?\b/gi, '')
    .replace(/\bquiet-state\s+wake loops?\b/gi, '')
    .replace(/\bwake loops?\b/gi, '')
    .replace(/\binternal checks?\b/gi, '')
    .replace(/\bself-reflection brews?\b/gi, '')
    .replace(/\btool auth errors?\b/gi, '')
    .replace(/\bschedule_list\b/gi, '')
    .replace(/\buser_id missing\b/gi, '')
    .replace(/\bno live ms365 access\b/gi, '')
    .replace(/\bms365 no access\b/gi, '')
    .replace(/\bmorning briefings repeated\b/gi, '')
    .replace(/\bidentical loops?\b/gi, '')
    .replace(/\bquiet state\b/gi, '')
    .replace(/\brepeated checks?\b/gi, '')
    .replace(/\{NTA\}/gi, '')
    .replace(NOISY_SEMICOLON_RUN_RE, '; ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^"(.*)"$/, '$1');
}

function getBlockedPattern(value: string): string | undefined {
  const pattern = NOISE_PATTERNS.find((candidate) => candidate.test(value));
  return pattern?.source;
}

function matchesNoiseLine(line: string): boolean {
  return EXISTING_MEMORY_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function containsSeparatorCorruption(value?: string): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  return NOISY_SEMICOLON_RUN_TEST_RE.test(value);
}

function containsWorldTemporalResidue(value: string): boolean {
  return splitWorldClauses(value).some((clause) =>
    shouldDropWorldClause(sanitizeWorldClause(clause)),
  );
}

function splitLabel(value: string): [string | null, string] {
  const index = value.indexOf(':');
  if (index === -1) {
    return [null, value.trim()];
  }
  return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
}

function splitWorldClauses(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|;\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitTopLevelList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')' && depth > 0) {
      depth -= 1;
    }

    if ((char === ',' || char === ';') && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function sanitizeWorldClause(value: string): string {
  return sanitizeOperationalText(value)
    .replace(URL_RE, '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '')
    .replace(/\(([^()]*)\)/g, (_match, inner: string) => {
      const kept = dedupeLines(
        splitTopLevelList(inner)
          .map((part) => sanitizeWorldClause(part))
          .filter(Boolean)
          .filter((part) => !shouldDropWorldClause(part)),
      );
      return kept.length > 0 ? `(${kept.join(', ')})` : '';
    })
    .replace(/\bturning\s+\d{1,2},?\s*\d{4}\b/gi, '')
    .replace(/\b(?:2\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .replace(/\(\s*\)/g, '')
    .replace(/\s+\)/g, ')')
    .replace(/\(\s+/g, '(')
    .replace(/^[,.;:-]+/, '')
    .replace(/[,.;:-]+$/, '')
    .trim();
}

function shouldDropWorldClause(value: string): boolean {
  if (!value) {
    return true;
  }

  if (hasWorldContactLogistics(value)) {
    return true;
  }

  const hasTemporalMarker = WORLD_TEMPORAL_MARKERS.some((pattern) => pattern.test(value));
  const hasTransientState = WORLD_TRANSIENT_STATE_PATTERNS.some((pattern) => pattern.test(value));
  const hasKeepPattern = WORLD_KEEP_PATTERNS.some((pattern) => pattern.test(value));
  const hasDropPattern = WORLD_DROP_PATTERNS.some((pattern) => pattern.test(value));

  if ((hasTemporalMarker || hasTransientState) && !hasKeepPattern) {
    return true;
  }

  return hasDropPattern && !hasKeepPattern;
}

function hasWorldContactLogistics(value: string): boolean {
  return WORLD_CONTACT_LOGISTICS_PATTERNS.some((pattern) => pattern.test(value));
}

function trimWorldCandidateToLimit(value: string, keyLimit: number): string {
  const rawLines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const updatedLine =
    rawLines.find((line) => /^_updated:/i.test(line)) || `_updated: ${formatDateOnly(new Date())}`;
  const relationshipLines = rawLines.filter(
    (line) =>
      line !== 'Ventures:' &&
      !line.startsWith('- ') &&
      !/^Key people:/i.test(line) &&
      !/^_updated:/i.test(line),
  );
  let ventureLines = rawLines.filter((line) => line.startsWith('- '));
  let peopleLine = rawLines.find((line) => /^Key people:/i.test(line)) || '';

  const build = () => {
    const nextLines = [...relationshipLines];
    if (ventureLines.length > 0) {
      nextLines.push('Ventures:', ...ventureLines);
    }
    if (peopleLine) {
      nextLines.push(peopleLine);
    }
    nextLines.push(updatedLine);
    return nextLines.join('\n').trim();
  };

  let candidate = build();
  if (countTokens(candidate) <= keyLimit) {
    return candidate;
  }

  if (peopleLine) {
    peopleLine = compactWorldPeopleLine(peopleLine, 6, 3);
    candidate = build();
  }
  if (countTokens(candidate) <= keyLimit) {
    return candidate;
  }

  peopleLine = '';
  candidate = build();
  if (countTokens(candidate) <= keyLimit) {
    return candidate;
  }

  if (ventureLines.length > 1) {
    ventureLines = ventureLines.slice(0, 1);
    candidate = build();
  }
  if (countTokens(candidate) <= keyLimit) {
    return candidate;
  }

  ventureLines = ventureLines.map((line) => compactWorldEntry(line, 6)).filter(Boolean);
  candidate = build();
  if (countTokens(candidate) <= keyLimit) {
    return candidate;
  }

  const fallbackLines = relationshipLines
    .map((line) => compactWorldEntry(line, 8))
    .filter(Boolean)
    .slice(0, 1);
  if (ventureLines.length > 0) {
    fallbackLines.push(ventureLines[0]);
  }
  fallbackLines.push(updatedLine);

  return truncateWords(fallbackLines.join('\n').split(/\s+/).filter(Boolean), keyLimit);
}

function sanitizeTokenCount(value?: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return 0;
}

function countTokens(value: string): number {
  return Tokenizer.getTokenCount(value, TODAY_TOKEN_ENCODING);
}

function getTotalTokens(memories: MemoryEntryLike[]): number {
  return memories.reduce((sum, memory) => sum + sanitizeTokenCount(memory.tokenCount), 0);
}

function isMarkerLine(line: string): boolean {
  return /^_(?:updated|expires|stale_after|confirmed|v):/i.test(line);
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDateMarker(
  value: string,
  marker: '_updated' | '_expires' | '_stale_after',
): string | null {
  const match = value.match(new RegExp(`${marker}:\\s*(\\d{4}-\\d{2}-\\d{2})`, 'i'));
  return match?.[1] ?? null;
}

function isDateMarkerBefore(
  value: string,
  marker: '_expires' | '_stale_after',
  now: Date,
): boolean {
  const markerValue = getDateMarker(value, marker);
  if (!markerValue || !DATE_ONLY_RE.test(markerValue)) {
    return false;
  }
  return markerValue < formatDateOnly(now);
}

function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split('-').map((value) => Number.parseInt(value, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function hasExpiredContextSnapshot(value: string | undefined, now: Date): boolean {
  if (!value) {
    return false;
  }
  return isDateMarkerBefore(value, '_expires', now);
}

function hasExpiredWorkingSnapshot(value: string | undefined, now: Date): boolean {
  if (!value) {
    return false;
  }
  return isDateMarkerBefore(value, '_stale_after', now) || isDateMarkerBefore(value, '_expires', now);
}

function hasLongIdleActiveDrafts(value: string | undefined, now: Date): boolean {
  if (!value) {
    return false;
  }
  return parseDrafts(value).some(
    (record) => !record.archived && (record.status || '').toLowerCase() === 'in_progress' && isLongIdleActiveDraft(record, now),
  );
}

function isLongIdleActiveDraft(record: DraftRecord, now: Date): boolean {
  const dateValue = record.lastWorked || record.started;
  if (!dateValue) {
    return false;
  }
  return addDays(dateValue, STALE_IN_PROGRESS_DRAFT_ARCHIVE_DAYS) <= formatDateOnly(now);
}

function isArchiveableDraft(record: DraftRecord, now: Date): boolean {
  if (record.archived) {
    return true;
  }

  const status = (record.status || '').toLowerCase();
  if (!status) {
    return false;
  }

  if (status === 'in_progress') {
    return isLongIdleActiveDraft(record, now);
  }

  if (!['done', 'paused'].includes(status)) {
    return false;
  }

  const dateValue = record.lastWorked || record.started;
  if (!dateValue) {
    return true;
  }
  return addDays(dateValue, 7) <= formatDateOnly(now);
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const key = normalizeText(line).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
  }
  return result;
}
