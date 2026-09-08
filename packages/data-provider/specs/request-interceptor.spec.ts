/**
 * @jest-environment @happy-dom/jest-environment
 */
import axios, { AxiosError } from 'axios';
import request from '../src/request';
import { setTokenHeader } from '../src/headers-helpers';

/**
 * The response interceptor in request.ts registers at import time when
 * `typeof window !== 'undefined'` (happy-dom provides window).
 *
 * We use axios's built-in request adapter mock to avoid real HTTP calls,
 * and verify the interceptor's behavior by observing whether a 401 triggers
 * a refresh POST or is immediately rejected.
 *
 * happy-dom is used instead of jsdom because it allows overriding
 * window.location via Object.defineProperty, which jsdom 26+ blocks.
 */

const mockAdapter = jest.fn();
let originalAdapter: typeof axios.defaults.adapter;
let savedLocation: Location;

beforeAll(() => {
  originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = mockAdapter;
});

describe('refresh rejection recovery', () => {
  it.each([401, 403, 503])(
    'settles concurrent requests after refresh status %s, then permits another refresh',
    async (status) => {
      setTokenHeader('expired-token');
      let rejectRefresh: () => void = () => {};
      let refreshStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      mockAdapter.mockImplementation((config) => {
        if (config.url.includes('/api/auth/refresh')) {
          refreshStarted();
          return new Promise((_resolve, reject) => {
            rejectRefresh = () => reject({ response: { status }, config });
          });
        }
        return Promise.reject({ response: { status: 401 }, config });
      });

      const requests = Promise.allSettled([axios.get('/api/messages'), axios.get('/api/user')]);
      await started;
      rejectRefresh();
      const result = await Promise.race([
        requests,
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 200)),
      ]);
      expect(result).not.toBe('hung');
      expect(result).toMatchObject([
        { status: 'rejected', reason: { response: { status } } },
        { status: 'rejected', reason: { response: { status } } },
      ]);
      expect(
        mockAdapter.mock.calls.filter(([config]) => config.url.includes('/api/auth/refresh')),
      ).toHaveLength(1);

      mockAdapter.mockImplementation((config) => {
        if (config.url.includes('/api/auth/refresh')) {
          return Promise.resolve({ data: { token: 'reconnected-token' }, status: 200, config });
        }
        if (config._retry) {
          return Promise.resolve({ data: { messages: [] }, status: 200, config });
        }
        return Promise.reject({ response: { status: 401 }, config });
      });
      await expect(axios.get('/api/messages')).resolves.toMatchObject({ data: { messages: [] } });
    },
  );

  it('does not recursively refresh a rejected initial session check', async () => {
    setTokenHeader('expired-token');
    mockAdapter.mockImplementation((config) =>
      Promise.reject({ response: { status: 401 }, config }),
    );
    await expect(axios.post('/api/auth/refresh')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });

  it('settles concurrent requests after a refresh timeout and permits another refresh', async () => {
    setTokenHeader('expired-token');
    let rejectRefresh: () => void = () => {};
    let refreshStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    mockAdapter.mockImplementation((config) => {
      if (config.url.includes('/api/auth/refresh')) {
        refreshStarted();
        return new Promise((_resolve, reject) => {
          rejectRefresh = () =>
            reject(new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config));
        });
      }
      return Promise.reject({ response: { status: 401 }, config });
    });

    const requests = Promise.allSettled([axios.get('/api/messages'), axios.get('/api/user')]);
    await started;
    rejectRefresh();
    await expect(requests).resolves.toMatchObject([
      { status: 'rejected', reason: { code: 'ECONNABORTED' } },
      { status: 'rejected', reason: { code: 'ECONNABORTED' } },
    ]);
    expect(
      mockAdapter.mock.calls.filter(([config]) => config.url.includes('/api/auth/refresh')),
    ).toHaveLength(1);

    mockAdapter.mockImplementation((config) => {
      if (config.url.includes('/api/auth/refresh')) {
        return Promise.resolve({ data: { token: 'reconnected-token' }, status: 200, config });
      }
      if (config._retry) {
        return Promise.resolve({ data: { messages: [] }, status: 200, config });
      }
      return Promise.reject({ response: { status: 401 }, config });
    });
    await expect(axios.get('/api/messages')).resolves.toMatchObject({ data: { messages: [] } });
  });

  it('keeps the refresh deadline local to refresh requests', async () => {
    const defaultTimeout = axios.defaults.timeout;
    mockAdapter.mockImplementation((config) =>
      Promise.resolve({ data: { token: 'valid-token' }, status: 200, config }),
    );

    await request.refreshToken();
    await request.refreshToken(true);
    await request.post('/api/agents/chat', { text: 'A long request' });
    expect(mockAdapter.mock.calls.map(([config]) => config.timeout)).toEqual([
      15_000,
      15_000,
      defaultTimeout,
    ]);
    expect(axios.defaults.timeout).toBe(defaultTimeout);
  });
});

beforeEach(() => {
  mockAdapter.mockReset();
  savedLocation = window.location;
});

afterAll(() => {
  axios.defaults.adapter = originalAdapter;
});

afterEach(() => {
  delete axios.defaults.headers.common['Authorization'];
  Object.defineProperty(window, 'location', {
    value: savedLocation,
    writable: true,
    configurable: true,
  });
});

function setWindowLocation(overrides: Partial<Location>) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, ...overrides },
    writable: true,
    configurable: true,
  });
}

describe('axios 401 interceptor — Authorization header guard', () => {
  it('skips refresh and rejects when Authorization header is cleared', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });

  it('attempts refresh on shared link page even without Authorization header', async () => {
    expect.assertions(2);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/share/abc123',
      pathname: '/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/share/abc123', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: 'new-token' },
      status: 200,
      headers: {},
      config: {},
    });

    mockAdapter.mockResolvedValueOnce({
      data: { sharedLink: {} },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/share/abc123');
    } catch {
      // may reject depending on exact flow
    }

    expect(mockAdapter.mock.calls.length).toBe(3);

    const refreshCall = mockAdapter.mock.calls[1];
    expect(refreshCall[0].url).toContain('api/auth/refresh');
  });

  it('does not bypass guard when share/ appears only in query params', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/c/chat?ref=share/token',
      pathname: '/c/chat',
      search: '?ref=share/token',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });

  it('redirects to login with redirect_to when unauthenticated on share page and refresh fails', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/share/abc123',
      pathname: '/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/share/abc123', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/share/abc123');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login?redirect_to=%2Fshare%2Fabc123');
  });

  it('redirects to login with redirect_to when authenticated and refresh returns no token on share page', async () => {
    expect.assertions(1);
    setTokenHeader('some-token');

    setWindowLocation({
      href: 'http://localhost/share/abc123',
      pathname: '/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/share/abc123', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/share/abc123');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login?redirect_to=%2Fshare%2Fabc123');
  });

  it('redirects to login with redirect_to when refresh returns no token on regular page', async () => {
    expect.assertions(1);
    setTokenHeader('some-token');

    setWindowLocation({
      href: 'http://localhost/c/some-conversation',
      pathname: '/c/some-conversation',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login?redirect_to=%2Fc%2Fsome-conversation');
  });

  it('redirects to plain /login without redirect_to when already on a login path', async () => {
    expect.assertions(1);
    setTokenHeader('some-token');

    setWindowLocation({
      href: 'http://localhost/login/2fa',
      pathname: '/login/2fa',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login');
  });

  it('attempts refresh when Authorization header is present', async () => {
    expect.assertions(2);
    setTokenHeader('valid-token');

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {}, _retry: false },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: 'new-token' },
      status: 200,
      headers: {},
      config: {},
    });

    mockAdapter.mockResolvedValueOnce({
      data: { messages: [] },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // may reject depending on exact flow
    }

    expect(mockAdapter.mock.calls.length).toBe(3);

    const refreshCall = mockAdapter.mock.calls[1];
    expect(refreshCall[0].url).toContain('api/auth/refresh');
  });
});
