/* === VIVENTIUM START ===
 * File: packages/data-schemas/src/methods/memory.ts
 *
 * Purpose:
 * - Track and preserve all Viventium modifications to this upstream LibreChat memory schema helper.
 *
 * Why a file-level wrapper:
 * - This file has multiple scattered Viventium guardrails (ex: preventing destructive `moments` rewrites).
 *   Wrapping the whole file prevents missing any changes during manual porting to a newer upstream version.
 *
 * Porting (manual onto new upstream):
 * - Re-apply this file as a patch against upstream (see docs/requirements_and_learnings/05_Open_Source_Modifications.md).
 * - Search inside this file for `VIVENTIUM NOTE` for section-level intent notes.
 *
 * Added: 2026-02-07
 */
import { Types } from 'mongoose';
import logger from '~/config/winston';
import type * as t from '~/types';

/**
 * Formats a date in YYYY-MM-DD format
 */
const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

// Factory function that takes mongoose instance and returns the methods
export function createMemoryMethods(mongoose: typeof import('mongoose')) {
	  /* === VIVENTIUM NOTE ===
	   * Feature: Guardrail for destructive `moments` rewrites
   *
   * Observed failure mode (managed cloud):
   * - Memory agent sometimes writes `moments` with a placeholder like "[previous moments preserved]"
   *   which is a destructive rewrite: prior moments are lost from the stored value.
   *
   * This helper merges the existing moments list with any newly provided moments when that placeholder
   * is present, producing a clean multi-line list. This is intentionally conservative and only
	   * activates for the explicit placeholder token.
	   *
	   * Added: 2026-02-07
	   */
	  const PREVIOUS_MOMENTS_PLACEHOLDER_RE = /\[previous moments preserved\]/gi;

  const normalizeMomentEntry = (entry: string): string =>
    (entry || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const extractMomentEntries = (raw: string): string[] => {
    const text = (raw || '').replace(PREVIOUS_MOMENTS_PLACEHOLDER_RE, '').trim();
    if (!text) {
      return [];
    }

    // Preferred: split by repeated "- YYYY-MM..." markers (handles the one-line, multi-entry failure mode).
    const markerRe = /-\s*\d{4}-\d{2}(?:-\d{2})?\s*\|/g;
    const matches = Array.from(text.matchAll(markerRe)).map((m) => m.index).filter((i) => i != null) as number[];

    const entries: string[] = [];
    if (matches.length > 0) {
      const starts = matches.sort((a, b) => a - b);
      for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] : text.length;
        const chunk = text.slice(start, end).trim();
        if (!chunk) {
          continue;
        }
        // Normalize to a single line per moment entry.
        entries.push(chunk.replace(/\s*\r?\n\s*/g, ' ').trim());
      }
      return entries;
    }

    // Fallback: treat it as a normal Markdown list (one entry per line).
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '));
  };

  const trimMoments = (entries: string[], maxEntries = 15): string[] => {
    if (!Array.isArray(entries) || entries.length <= maxEntries) {
      return entries;
    }

    const pinnedIdx: number[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const lower = (entries[i] || '').toLowerCase();
      if (lower.includes('| milestone |')) {
        pinnedIdx.push(i);
      }
    }

    if (pinnedIdx.length >= maxEntries) {
      // Too many pinned entries; keep the most recent pinned items.
      return pinnedIdx
        .slice(-maxEntries)
        .map((i) => entries[i])
        .filter(Boolean);
    }

    const pinnedSet = new Set(pinnedIdx);
    const keepNormalized = new Set<string>();
    for (const idx of pinnedIdx) {
      keepNormalized.add(normalizeMomentEntry(entries[idx]));
    }

    // Fill remaining slots from the end (most recent), excluding pinned.
    for (let i = entries.length - 1; i >= 0 && keepNormalized.size < maxEntries; i -= 1) {
      if (pinnedSet.has(i)) {
        continue;
      }
      keepNormalized.add(normalizeMomentEntry(entries[i]));
    }

    const final: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const normalized = normalizeMomentEntry(entry);
      if (!keepNormalized.has(normalized)) {
        continue;
      }
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      final.push(entry);
    }
    return final;
  };

	  const mergeMomentsValue = (existingValue: string, incomingValue: string): string => {
    const existingEntries = extractMomentEntries(existingValue);
    const incomingEntries = extractMomentEntries(incomingValue);

    const merged: string[] = [];
    const seen = new Set<string>();

    for (const entry of existingEntries) {
      const normalized = normalizeMomentEntry(entry);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(entry);
    }

    for (const entry of incomingEntries) {
      const normalized = normalizeMomentEntry(entry);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(entry);
    }

	    return trimMoments(merged).join('\n');
	  };
	  /* === VIVENTIUM NOTE END === */

	  /**
	   * Creates a new memory entry for a user
	   * Throws an error if a memory with the same key already exists
	   */
  async function createMemory({
    userId,
    key,
    value,
    tokenCount = 0,
  }: t.SetMemoryParams): Promise<t.MemoryResult> {
    try {
      if (key?.toLowerCase() === 'nothing') {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      const existingMemory = await MemoryEntry.findOne({ userId, key });
      if (existingMemory) {
        throw new Error('Memory with this key already exists');
      }

      await MemoryEntry.create({
        userId,
        key,
        value,
        tokenCount,
        updated_at: new Date(),
      });

      return { ok: true };
    } catch (error) {
      throw new Error(
        `Failed to create memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Sets or updates a memory entry for a user
   */
	  async function setMemory({
	    userId,
	    key,
	    value,
	    tokenCount = 0,
	  }: t.SetMemoryParams): Promise<t.MemoryResult> {
	    try {
	      if (key?.toLowerCase() === 'nothing') {
	        return { ok: false };
	      }

	      const MemoryEntry = mongoose.models.MemoryEntry;

	      /* === VIVENTIUM NOTE ===
	       * Feature: Prevent placeholder-based `moments` data loss
	       *
	       * Purpose:
	       * - If the incoming value contains the placeholder token, merge in the existing moments list
	       *   to ensure the stored value is additive (no "[previous moments preserved]" destructive rewrites).
	       *
	       * Added: 2026-02-07
	       */
	      let finalValue = value;
	      if (
	        typeof finalValue === 'string' &&
	        typeof key === 'string' &&
	        key.toLowerCase() === 'moments' &&
	        PREVIOUS_MOMENTS_PLACEHOLDER_RE.test(finalValue)
	      ) {
	        const existing = await MemoryEntry.findOne({ userId, key }).lean();
	        if (existing?.value && typeof existing.value === 'string') {
	          finalValue = mergeMomentsValue(existing.value, finalValue);
	        } else {
	          finalValue = finalValue.replace(PREVIOUS_MOMENTS_PLACEHOLDER_RE, '').trim();
	        }
	      }

	      await MemoryEntry.findOneAndUpdate(
	        { userId, key },
	        {
	          value: finalValue,
	          tokenCount,
	          updated_at: new Date(),
	        },
	        {
	          upsert: true,
	          new: true,
	        },
	      );
	      /* === VIVENTIUM NOTE END === */

	      return { ok: true };
	    } catch (error) {
	      throw new Error(
	        `Failed to set memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Deletes a specific memory entry for a user
   */
  async function deleteMemory({ userId, key }: t.DeleteMemoryParams): Promise<t.MemoryResult> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const result = await MemoryEntry.findOneAndDelete({ userId, key });
      return { ok: !!result };
    } catch (error) {
      throw new Error(
        `Failed to delete memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets all memory entries for a user
   */
  async function getAllUserMemories(
    userId: string | Types.ObjectId,
  ): Promise<t.IMemoryEntryLean[]> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      return (await MemoryEntry.find({ userId }).lean()) as t.IMemoryEntryLean[];
    } catch (error) {
      throw new Error(
        `Failed to get all memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets and formats all memories for a user in two different formats
   */
	  async function getFormattedMemories({
	    userId,
	  }: t.GetFormattedMemoriesParams): Promise<t.FormattedMemoriesResult> {
	    try {
	      const memories = await getAllUserMemories(userId);

      if (!memories || memories.length === 0) {
        return { withKeys: '', withoutKeys: '', totalTokens: 0, memoryTokenMap: {} };
      }

      const sortedMemories = memories.sort(
        (a, b) => new Date(a.updated_at!).getTime() - new Date(b.updated_at!).getTime(),
      );

	      const totalTokens = sortedMemories.reduce((sum, memory) => {
	        return sum + (memory.tokenCount || 0);
	      }, 0);

	      /* === VIVENTIUM START ===
	       * Fix: Expose per-key token counts to prevent memory tokenLimit double-counting.
	       *
	       * Why:
	       * - The memory agent writes full replacement values per key.
	       * - Token limit checks must account for overwrites (delta = new - old), not treat them as append-only.
	       *
	       * Added: 2026-02-09
	       * === VIVENTIUM END === */
	      const memoryTokenMap = sortedMemories.reduce(
	        (acc, memory) => {
	          acc[memory.key] = memory.tokenCount ?? 0;
	          return acc;
	        },
	        {} as Record<string, number>,
	      );

		      /* === VIVENTIUM NOTE ===
		       * Feature: LLM-parseable memory formatting (no quoted multi-line values)
	       *
	       * These strings are consumed by LLMs:
       * - Main agent context injection
       * - Memory agent "existing memory" context for additive updates
       *
       * Avoid wrapping values in quotes: memories are frequently multi-line and can contain quotes,
	       * which makes quoted formats ambiguous/unparseable and increases the chance of "rewrite" bugs.
	       *
	       * Added: 2026-02-07
	       */
	      const withKeys = sortedMemories
	        .map((memory) => {
	          const date = formatDate(new Date(memory.updated_at!));
	          const tokenCount = memory.tokenCount ?? 0;
          const header = `## ${memory.key}\n(updated_at: ${date}, tokens: ${tokenCount})`;
          return `${header}\n${memory.value}`;
        })
        .join('\n\n---\n\n');

      const withoutKeys = sortedMemories
        .map((memory) => {
          const header = `## ${memory.key}`;
          return `${header}\n${memory.value}`;
        })
        .join('\n\n');
      /* === VIVENTIUM NOTE END === */

      return { withKeys, withoutKeys, totalTokens, memoryTokenMap };
    } catch (error) {
      logger.error('Failed to get formatted memories:', error);
      return { withKeys: '', withoutKeys: '', totalTokens: 0, memoryTokenMap: {} };
    }
  }

  return {
    setMemory,
    createMemory,
    deleteMemory,
    getAllUserMemories,
    getFormattedMemories,
  };
}

export type MemoryMethods = ReturnType<typeof createMemoryMethods>;

/* === VIVENTIUM END === */
