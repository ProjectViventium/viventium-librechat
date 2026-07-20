/**
 * === VIVENTIUM START ===
 * Feature: Revision-safe saved-memory mutation regression coverage.
 * Purpose: Prove conflicts invalidate cached state so the UI refetches authoritative memory data.
 * === VIVENTIUM END ===
 */

import { QueryKeys } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDeleteMemoryMutation, useUpdateMemoryMutation } from './queries';

jest.mock('@tanstack/react-query', () => ({
  useMutation: jest.fn((_mutationFn, options) => ({ options })),
  useQuery: jest.fn(),
  useQueryClient: jest.fn(),
}));

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUseQueryClient = useQueryClient as jest.MockedFunction<typeof useQueryClient>;

describe('revision-safe memory mutations', () => {
  const invalidateQueries = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseQueryClient.mockReturnValue({ invalidateQueries } as never);
  });

  test('delete conflict invalidates memories for an authoritative refetch', () => {
    useDeleteMemoryMutation();
    const options = mockUseMutation.mock.calls[0][1] as {
      onError?: (error: unknown) => void;
    };

    options.onError?.({ response: { status: 409 } });

    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.memories]);
  });

  test('update conflict invalidates memories and preserves the caller error callback', () => {
    const onError = jest.fn();
    useUpdateMemoryMutation({ onError } as never);
    const options = mockUseMutation.mock.calls[0][1] as {
      onError?: (...args: unknown[]) => void;
    };
    const conflict = { response: { status: 409 } };

    options.onError?.(conflict, { key: 'context' }, undefined);

    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.memories]);
    expect(onError).toHaveBeenCalledWith(conflict, { key: 'context' }, undefined);
  });
});
