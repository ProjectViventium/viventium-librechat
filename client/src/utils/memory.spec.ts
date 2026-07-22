/**
 * === VIVENTIUM START ===
 * Feature: Revision-safe saved-memory reducer regression coverage.
 * Purpose: Prove optimistic artifacts cannot overwrite newer authoritative memory state.
 * === VIVENTIUM END ===
 */

import type { MemoriesResponse, MemoryArtifact } from 'librechat-data-provider';
import { handleMemoryArtifact } from './memory';

const currentData = {
  memories: [
    {
      key: 'context',
      value: 'Older value',
      tokenCount: 2,
      updated_at: '2026-07-13T00:00:00.000Z',
      revision: 4,
    },
  ],
  totalTokens: 2,
  tokenLimit: 100,
  usagePercentage: 2,
} as MemoriesResponse;

describe('handleMemoryArtifact revision safety', () => {
  test('stores the post-write revision from a successful memory artifact', () => {
    const artifact: MemoryArtifact = {
      type: 'update',
      key: 'context',
      value: 'Current value',
      tokenCount: 3,
      revision: 5,
    };

    const result = handleMemoryArtifact({ memoryArtifact: artifact, currentData });

    expect(result?.memories[0]).toEqual(
      expect.objectContaining({ value: 'Current value', revision: 5 }),
    );
  });

  test('does not create stale optimistic state when the artifact has no revision', () => {
    const artifact: MemoryArtifact = {
      type: 'update',
      key: 'context',
      value: 'Unversioned value',
      tokenCount: 3,
    };

    expect(handleMemoryArtifact({ memoryArtifact: artifact, currentData })).toBeUndefined();
  });

  test('ignores delayed artifacts that are not newer than the cached revision', () => {
    const cachedRevisionFive = {
      ...currentData,
      memories: [{ ...currentData.memories[0], value: 'Newest value', revision: 5 }],
    } as MemoriesResponse;

    for (const revision of [4, 5]) {
      const artifact: MemoryArtifact = {
        type: 'update',
        key: 'context',
        value: 'Delayed value',
        tokenCount: 3,
        revision,
      };

      expect(
        handleMemoryArtifact({ memoryArtifact: artifact, currentData: cachedRevisionFive }),
      ).toBeUndefined();
    }
  });

  test('leaves delete reconciliation to the authoritative memories query', () => {
    const artifact: MemoryArtifact = {
      type: 'delete',
      key: 'context',
      revision: 6,
    };

    expect(handleMemoryArtifact({ memoryArtifact: artifact, currentData })).toBeUndefined();
  });

  test('does not resurrect an absent key from a delayed update artifact', () => {
    const deletedData = {
      ...currentData,
      memories: [],
      totalTokens: 0,
      usagePercentage: 0,
    } as MemoriesResponse;
    const artifact: MemoryArtifact = {
      type: 'update',
      key: 'context',
      value: 'Delayed value',
      tokenCount: 3,
      revision: 5,
    };

    expect(
      handleMemoryArtifact({ memoryArtifact: artifact, currentData: deletedData }),
    ).toBeUndefined();
  });
});
