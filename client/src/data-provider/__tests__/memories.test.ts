import { dataService as _dataService } from 'librechat-data-provider';
import axios from 'axios';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('getMemories', () => {
  it('should fetch memories from /api/memories', async () => {
    const mockData = [{ key: 'foo', value: 'bar', updated_at: '2024-05-01T00:00:00Z' }];

    mockedAxios.get.mockResolvedValueOnce({ data: mockData } as any);

    const result = await (_dataService as any).getMemories();

    expect(mockedAxios.get).toHaveBeenCalledWith('/api/memories', expect.any(Object));
    expect(result).toEqual(mockData);
  });
});

describe('saved-memory entry mutations', () => {
  it('updates a saved memory through the collision-free entry endpoint', async () => {
    mockedAxios.patch.mockResolvedValueOnce({ data: { updated: true } } as any);

    await (_dataService as any).updateMemory('preferences', 'new value', 2);

    expect(mockedAxios.patch).toHaveBeenCalledWith(
      '/api/memories/entries/preferences',
      JSON.stringify({ key: 'preferences', value: 'new value', expectedRevision: 2 }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('deletes a saved memory through the collision-free entry endpoint', async () => {
    mockedAxios.delete.mockResolvedValueOnce({ data: { deleted: true } } as any);

    await (_dataService as any).deleteMemory('preferences', 4);

    expect(mockedAxios.delete).toHaveBeenCalledWith(
      '/api/memories/entries/preferences?revision=4',
    );
  });
});
