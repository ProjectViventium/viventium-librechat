import type { MemoriesResponse, TUserMemory, MemoryArtifact } from 'librechat-data-provider';

type HandleMemoryArtifactParams = {
  memoryArtifact: MemoryArtifact;
  currentData: MemoriesResponse;
};

/**
 * Pure function to handle memory artifact updates
 * @param params - Object containing memoryArtifact and currentData
 * @returns Updated MemoriesResponse or undefined if no update needed
 */
export function handleMemoryArtifact({
  memoryArtifact,
  currentData,
}: HandleMemoryArtifactParams): MemoriesResponse | undefined {
  const { type, key, value, tokenCount = 0 } = memoryArtifact;

  if (type === 'update' && !value) {
    return undefined;
  }

  const memories = currentData.memories;
  const existingIndex = memories.findIndex((m) => m.key === key);

  if (type === 'delete') {
    /* === VIVENTIUM START ===
     * The cache does not retain tombstones, so it cannot order a delayed delete safely. The SSE
     * attachment handler always invalidates this query; let that authoritative refetch remove it.
     * === VIVENTIUM END === */
    return undefined;
  }

  if (type === 'update') {
    /* === VIVENTIUM START ===
     * A successful writer artifact must carry its post-write revision. Without it, leave the
     * optimistic cache untouched so the attachment handler's authoritative refetch can replace it.
     */
    if (!Number.isInteger(memoryArtifact.revision) || (memoryArtifact.revision ?? -1) < 0) {
      return undefined;
    }
    // An absent key may have a newer tombstone that this cache cannot see. Refetch before adding it.
    if (existingIndex < 0) {
      return undefined;
    }
    if (
      Number.isInteger(memories[existingIndex].revision) &&
      memoryArtifact.revision! <= memories[existingIndex].revision!
    ) {
      return undefined;
    }
    /* === VIVENTIUM END === */
    const timestamp = new Date().toISOString();
    let totalTokens = currentData.totalTokens;
    let newMemories: TUserMemory[];

    const oldTokenCount = memories[existingIndex].tokenCount || 0;
    totalTokens = totalTokens - oldTokenCount + tokenCount;

    newMemories = [...memories];
    newMemories[existingIndex] = {
      key,
      value: value!,
      tokenCount,
      updated_at: timestamp,
      /* === VIVENTIUM START === Preserve the writer's post-write revision. === */
      revision: memoryArtifact.revision!,
      /* === VIVENTIUM END === */
    };

    const usagePercentage = currentData.tokenLimit
      ? Math.min(100, Math.round((totalTokens / currentData.tokenLimit) * 100))
      : null;

    return {
      ...currentData,
      memories: newMemories,
      totalTokens,
      usagePercentage,
    };
  }

  return undefined;
}
