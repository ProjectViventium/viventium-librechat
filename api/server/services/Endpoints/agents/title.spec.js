jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => true),
  sanitizeTitle: jest.fn((title) => title),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockSet = jest.fn();

jest.mock('~/cache/getLogStores', () => jest.fn(() => ({ set: mockSet })));
jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
}));

const addTitle = require('./title');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo } = require('~/models');

describe('agents addTitle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses a fallback title when async title generation fails', async () => {
    const req = {
      user: { id: 'user-1' },
      body: {},
    };
    const client = {
      titleConvo: jest.fn().mockRejectedValue(new Error('Run not initialized')),
      options: {},
    };

    await addTitle(req, {
      text: 'check my ms365 inbox',
      response: { conversationId: 'convo-1' },
      client,
    });

    expect(getLogStores).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith('user-1-convo-1', 'check my ms365 inbox', 120000);
    expect(saveConvo).toHaveBeenCalledWith(
      req,
      {
        conversationId: 'convo-1',
        title: 'check my ms365 inbox',
      },
      { context: 'api/server/services/Endpoints/agents/title.js' },
    );
  });

  it('uses a fallback title when no title is returned', async () => {
    const req = {
      user: { id: 'user-2' },
      body: {},
    };
    const client = {
      titleConvo: jest.fn().mockResolvedValue(undefined),
      options: {},
    };

    await addTitle(req, {
      text: 'this is a deliberately long title seed that should truncate cleanly',
      response: { conversationId: 'convo-2' },
      client,
    });

    expect(mockSet).toHaveBeenCalledWith(
      'user-2-convo-2',
      'this is a deliberately long title see...',
      120000,
    );
    expect(saveConvo).toHaveBeenCalledWith(
      req,
      {
        conversationId: 'convo-2',
        title: 'this is a deliberately long title see...',
      },
      { context: 'api/server/services/Endpoints/agents/title.js', noUpsert: true },
    );
  });
});
