import { renderHook } from '@testing-library/react';
import { useGetEndpointsQuery } from '~/data-provider';
import { useUpdateUserKeysMutation, useUserKeyQuery } from 'librechat-data-provider/react-query';
import useUserKey from './useUserKey';

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateUserKeysMutation: jest.fn(),
  useUserKeyQuery: jest.fn(),
}));

describe('useUserKey', () => {
  it.each([null, '', undefined])(
    'does not turn missing expiry %s into a saved key',
    (expiresAt) => {
      (useGetEndpointsQuery as jest.Mock).mockReturnValue({ data: {} });
      (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt } });
      (useUpdateUserKeysMutation as jest.Mock).mockReturnValue({ mutateAsync: jest.fn() });
      const { result } = renderHook(() => useUserKey('anthropic'));
      expect(result.current.getExpiry()).toBeUndefined();
    },
  );

  it.each(['never', '2030-01-01T00:00:00.000Z'])('retains the saved expiry %s', (expiresAt) => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({ data: {} });
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: { expiresAt } });
    (useUpdateUserKeysMutation as jest.Mock).mockReturnValue({ mutateAsync: jest.fn() });
    const { result } = renderHook(() => useUserKey('anthropic'));
    expect(result.current.getExpiry()).toBe(expiresAt);
  });

  it('returns the key-save promise so the dialog can retain input and report a failed save', async () => {
    const mutateAsync = jest.fn().mockRejectedValue(new Error('synthetic save failure'));
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({ data: {} });
    (useUserKeyQuery as jest.Mock).mockReturnValue({ data: undefined });
    (useUpdateUserKeysMutation as jest.Mock).mockReturnValue({ mutateAsync });

    const { result } = renderHook(() => useUserKey('openAI'));

    await expect(
      result.current.saveUserKey('synthetic-key', Date.parse('2030-01-01T00:00:00.000Z')),
    ).rejects.toThrow('synthetic save failure');
    expect(mutateAsync).toHaveBeenCalledWith({
      name: 'openAI',
      value: 'synthetic-key',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
});
