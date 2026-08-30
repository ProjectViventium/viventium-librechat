import { hasKnownExternalWork } from './knownExternalWork';

describe('hasKnownExternalWork', () => {
  it('uses the exact owner-scoped Core attention query', async () => {
    const findOne = jest.fn(async () => ({ _id: 'known-work' }));

    await expect(
      hasKnownExternalWork({ ownerId: ' owner-1 ', collection: { findOne } }),
    ).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner-1', $or: expect.any(Array) }),
      { projection: { _id: 1 } },
    );
  });

  it('fails closed for a missing owner and returns false for no matching row', async () => {
    const findOne = jest.fn(async () => null);
    await expect(hasKnownExternalWork({ ownerId: '', collection: { findOne } })).resolves.toBe(
      false,
    );
    expect(findOne).not.toHaveBeenCalled();
    await expect(
      hasKnownExternalWork({ ownerId: 'owner-1', collection: { findOne } }),
    ).resolves.toBe(false);
  });
});
