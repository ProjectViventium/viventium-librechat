/** @jest-environment node */
import axios from 'axios';
import { createServer } from 'node:http';
import request from '../src/request';

it('ends an unanswered refresh at its deadline and permits a later successful refresh', async () => {
  const originalBaseURL = axios.defaults.baseURL;
  const originalAdapter = axios.defaults.adapter;
  const originalProxy = axios.defaults.proxy;
  const originalTimeout = axios.defaults.timeout;
  const received: string[] = [];
  let answerRefresh = false;
  const server = createServer((incoming, response) => {
    received.push(`${incoming.method} ${incoming.url}`);
    incoming.resume();
    if (answerRefresh) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token: 'recovered-token' }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The test server did not expose its port');
  }

  axios.defaults.baseURL = `http://127.0.0.1:${address.port}`;
  axios.defaults.adapter = 'http';
  axios.defaults.proxy = false;
  const watchdog = setTimeout(() => server.closeAllConnections(), 18_000);
  try {
    await expect(request.refreshToken()).rejects.toMatchObject({
      code: 'ECONNABORTED',
      config: { timeout: 15_000 },
    });
    clearTimeout(watchdog);
    expect(received).toEqual(['POST /api/auth/refresh']);
    expect(axios.defaults.timeout).toBe(originalTimeout);

    answerRefresh = true;
    await expect(request.refreshToken(true)).resolves.toEqual({ token: 'recovered-token' });
    expect(received).toEqual(['POST /api/auth/refresh', 'POST /api/auth/refresh?retry=true']);
  } finally {
    clearTimeout(watchdog);
    axios.defaults.baseURL = originalBaseURL;
    axios.defaults.adapter = originalAdapter;
    axios.defaults.proxy = originalProxy;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 25_000);
