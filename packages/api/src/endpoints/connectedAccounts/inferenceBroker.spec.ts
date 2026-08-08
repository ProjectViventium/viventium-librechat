import crypto from 'node:crypto';
import { EModelEndpoint } from 'librechat-data-provider';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  InferenceBrokerError,
  createGlassHiveInferenceBroker,
  createGlassHiveInferenceBrokerRouter,
  mintInferenceIssuerAssertion,
  verifyInferenceGrant,
  verifyInferenceIssuerAssertion,
} from './inferenceBroker';
import type { InferenceBrokerDependencies, IssuedInferenceGrant } from './inferenceBroker';

const MASTER_SECRET = 'synthetic-inference-broker-secret';
const RAW_PERSONAL_KEY = 'synthetic-personal-key-never-return';
const RAW_ENTERPRISE_KEY = 'synthetic-enterprise-key-never-return';
const NOW_MS = Date.parse('2026-08-05T12:00:00.000Z');

function stableContractJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableContractJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableContractJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resignToken(
  token: string,
  purpose: 'issuer' | 'grant',
  changes: Record<string, unknown>,
): string {
  const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  const unsigned = { ...claims, ...changes };
  delete unsigned.sig;
  const derived = crypto
    .createHmac('sha256', MASTER_SECRET)
    .update(`viventium-glasshive-inference:${purpose}:v1`)
    .digest();
  const sig = crypto
    .createHmac('sha256', derived)
    .update(stableContractJson(unsigned))
    .digest('base64url');
  return Buffer.from(JSON.stringify({ ...unsigned, sig }), 'utf8').toString('base64url');
}

function issuerAssertion(
  overrides: Partial<Parameters<typeof mintInferenceIssuerAssertion>[0]> = {},
): string {
  return mintInferenceIssuerAssertion({
    secret: MASTER_SECRET,
    tenantId: 'tenant-a',
    userId: 'user-a',
    workerId: 'worker-a',
    runId: 'run-a',
    provider: 'openai',
    route: 'personal_api_key',
    adapter: 'openai_chat_completions_v1',
    models: ['gpt-4.1-mini'],
    action: 'issue',
    nowMs: NOW_MS,
    ...overrides,
  }).token;
}

function dependencies(
  overrides: Partial<InferenceBrokerDependencies> = {},
): InferenceBrokerDependencies {
  return {
    secret: MASTER_SECRET,
    tenantId: 'tenant-a',
    proxyBaseUrl: 'https://librechat.example.test/api/viventium/glasshive/inference',
    now: () => NOW_MS,
    isUserActive: jest.fn().mockResolvedValue(true),
    getCredentialPolicy: jest.fn().mockResolvedValue('personal_preferred'),
    getUserKeyValues: jest.fn().mockResolvedValue({
      apiKey: RAW_PERSONAL_KEY,
      baseURL: 'https://api.openai.com/v1',
      headers: {
        Authorization: 'Bearer attacker-controlled',
        'OpenAI-Organization': 'org-safe',
        'X-Attacker-Header': 'must-not-forward',
      },
    }),
    getEnterpriseRoute: jest.fn().mockReturnValue({
      apiKey: RAW_ENTERPRISE_KEY,
      baseUrl: 'https://enterprise-openai.example.test/v1',
    }),
    assertGrantActive: jest.fn().mockResolvedValue(undefined),
    revokeGrant: jest.fn().mockResolvedValue(undefined),
    rememberGrantRequest: jest.fn().mockResolvedValue({ accepted: true, remaining: 9 }),
    fetch: jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'chatcmpl_synthetic', choices: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'must-not-forward=1',
          'x-request-id': 'req_synthetic',
        },
      }),
    ),
    log: jest.fn(),
    ...overrides,
  };
}

function proxyRequest(grantToken: string) {
  return {
    grantToken,
    workerId: 'worker-a',
    runId: 'run-a',
    body: {
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Synthetic request' }],
      stream: false,
      user: 'attacker-supplied-upstream-user',
    },
  };
}

function responsesProxyRequest(grantToken: string) {
  return {
    grantToken,
    workerId: 'worker-a',
    runId: 'run-a',
    body: {
      model: 'gpt-4.1-mini',
      input: 'Synthetic response request',
      stream: true,
      user: 'attacker-supplied-upstream-user',
      apiKey: 'attacker-supplied-api-key',
      baseURL: 'http://169.254.169.254/latest/meta-data',
      headers: { Authorization: 'Bearer attacker-controlled' },
    },
  };
}

describe('GlassHive inference broker signing contract', () => {
  it('binds issuer assertions to tenant, user, worker, run, provider, route, adapter, and model', () => {
    const token = issuerAssertion();
    const verified = verifyInferenceIssuerAssertion(token, {
      secret: MASTER_SECRET,
      tenantId: 'tenant-a',
      nowMs: NOW_MS,
    });

    expect(verified).toMatchObject({
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      worker_id: 'worker-a',
      run_id: 'run-a',
      provider: 'openai',
      route: 'personal_api_key',
      adapter: 'openai_chat_completions_v1',
      models: ['gpt-4.1-mini'],
      action: 'issue',
    });
  });

  it('rejects tampered, cross-tenant, and expired issuer assertions', () => {
    const token = issuerAssertion();
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<
      string,
      string
    >;
    const tampered = Buffer.from(
      JSON.stringify({ ...decoded, worker_id: 'worker-b' }),
      'utf8',
    ).toString('base64url');

    expect(() =>
      verifyInferenceIssuerAssertion(tampered, {
        secret: MASTER_SECRET,
        tenantId: 'tenant-a',
        nowMs: NOW_MS,
      }),
    ).toThrow('Invalid GlassHive inference issuer assertion');
    expect(() =>
      verifyInferenceIssuerAssertion(token, {
        secret: MASTER_SECRET,
        tenantId: 'tenant-b',
        nowMs: NOW_MS,
      }),
    ).toThrow('tenant mismatch');
    expect(() =>
      verifyInferenceIssuerAssertion(token, {
        secret: MASTER_SECRET,
        tenantId: 'tenant-a',
        nowMs: NOW_MS + 61_000,
      }),
    ).toThrow('expired');
  });

  it('rejects a correctly signed issuer assertion that exceeds the 60-second lifetime', () => {
    const token = issuerAssertion();
    const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      iat: number;
    };
    const overlong = resignToken(token, 'issuer', { exp: claims.iat + 61 });

    expect(() =>
      verifyInferenceIssuerAssertion(overlong, {
        secret: MASTER_SECRET,
        tenantId: 'tenant-a',
        nowMs: NOW_MS,
      }),
    ).toThrow('GlassHive inference issuer assertion expired');
  });
});

describe('GlassHive inference broker', () => {
  it('issues a deterministic short-lived grant without returning the personal key', async () => {
    const broker = createGlassHiveInferenceBroker(dependencies());
    const assertion = issuerAssertion();

    const first = await broker.issueGrant(assertion);
    const retried = await broker.issueGrant(assertion);
    const serialized = JSON.stringify(first);

    expect(retried).toEqual(first);
    expect(serialized).not.toContain(RAW_PERSONAL_KEY);
    expect(first).toMatchObject({
      provider: 'openai',
      route: 'personal_api_key',
      expiresAt: '2026-08-05T12:10:00.000Z',
      adapter: {
        id: 'openai_chat_completions_v1',
        baseUrl: 'https://librechat.example.test/api/viventium/glasshive/inference/openai/v1',
        auth: 'bearer_grant',
        paths: ['/chat/completions'],
        supportsStreaming: true,
      },
    });
    expect(
      verifyInferenceGrant(first.grantToken, {
        secret: MASTER_SECRET,
        tenantId: 'tenant-a',
        nowMs: NOW_MS,
      }),
    ).toMatchObject({
      user_id: 'user-a',
      worker_id: 'worker-a',
      run_id: 'run-a',
      provider: 'openai',
      route: 'personal_api_key',
    });
  });

  it('keeps retries idempotent while assigning different grant IDs to different model scopes', async () => {
    const broker = createGlassHiveInferenceBroker(dependencies());
    const firstAssertion = issuerAssertion({ models: ['gpt-4.1-mini'] });
    const widerAssertion = issuerAssertion({ models: ['gpt-4.1-mini', 'gpt-5-mini'] });

    const first = await broker.issueGrant(firstAssertion);
    const retried = await broker.issueGrant(firstAssertion);
    const wider = await broker.issueGrant(widerAssertion);

    expect(retried.grantId).toBe(first.grantId);
    expect(wider.grantId).not.toBe(first.grantId);
  });

  it('issues a fixed Responses API adapter grant without returning the personal key', async () => {
    const broker = createGlassHiveInferenceBroker(dependencies());
    const assertion = issuerAssertion({ adapter: 'openai_responses_v1' });

    const issued = await broker.issueGrant(assertion);

    expect(JSON.stringify(issued)).not.toContain(RAW_PERSONAL_KEY);
    expect(issued.adapter).toEqual({
      id: 'openai_responses_v1',
      baseUrl: 'https://librechat.example.test/api/viventium/glasshive/inference/openai/v1',
      auth: 'bearer_grant',
      paths: ['/responses'],
      supportsStreaming: true,
    });
  });

  it('rejects a correctly signed grant that exceeds the 10-minute lifetime', async () => {
    const broker = createGlassHiveInferenceBroker(dependencies());
    const issued = await broker.issueGrant(issuerAssertion());
    const claims = JSON.parse(Buffer.from(issued.grantToken, 'base64url').toString('utf8')) as {
      iat: number;
    };
    const overlong = resignToken(issued.grantToken, 'grant', { exp: claims.iat + 601 });

    expect(() =>
      verifyInferenceGrant(overlong, {
        secret: MASTER_SECRET,
        tenantId: 'tenant-a',
        nowMs: NOW_MS,
      }),
    ).toThrow('Invalid GlassHive inference grant');
  });

  it('forwards through the fixed personal OpenAI route and never trusts stored base URLs or headers', async () => {
    const deps = dependencies();
    const broker = createGlassHiveInferenceBroker(deps);
    const issued = await broker.issueGrant(issuerAssertion());

    const proxied = await broker.proxyChatCompletions(proxyRequest(issued.grantToken));
    const fetchMock = jest.mocked(deps.fetch);
    const [, request] = fetchMock.mock.calls[0];
    const headers = new Headers(request?.headers);
    const upstreamBody = JSON.parse(String(request?.body)) as Record<string, string>;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
    expect(headers.get('authorization')).toBe(`Bearer ${RAW_PERSONAL_KEY}`);
    expect(headers.get('openai-organization')).toBe('org-safe');
    expect(headers.get('x-attacker-header')).toBeNull();
    expect(upstreamBody.user).toBeUndefined();
    expect(proxied.status).toBe(200);
    expect(proxied.headers).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req_synthetic',
    });
    expect(await proxied.response.text()).not.toContain(RAW_PERSONAL_KEY);
    expect(JSON.stringify(jest.mocked(deps.log).mock.calls)).not.toContain(RAW_PERSONAL_KEY);
  });

  it('rejects a personal key stored for a different upstream instead of forwarding it to OpenAI', async () => {
    const getUserKeyValues = jest.fn().mockResolvedValue({
      apiKey: RAW_PERSONAL_KEY,
      baseURL: 'https://different-provider.example.test/v1',
    });
    const deps = dependencies({ getUserKeyValues });
    const broker = createGlassHiveInferenceBroker(deps);

    await expect(broker.issueGrant(issuerAssertion())).rejects.toMatchObject({
      code: 'credential_action_required',
      status: 409,
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('rejects upstream redirects instead of following an operator-route response', async () => {
    const fetch = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    );
    const deps = dependencies({ fetch });
    const broker = createGlassHiveInferenceBroker(deps);
    const issued = await broker.issueGrant(issuerAssertion({ route: 'enterprise_route' }));

    await expect(
      broker.proxyChatCompletions(proxyRequest(issued.grantToken)),
    ).rejects.toMatchObject({
      code: 'upstream_redirect_rejected',
      status: 502,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://enterprise-openai.example.test/v1/chat/completions',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('forwards Responses API requests only to the fixed route and strips client routing or auth fields', async () => {
    const fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_synthetic', debug: RAW_PERSONAL_KEY }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': `resp-${RAW_PERSONAL_KEY}`,
        },
      }),
    );
    const deps = dependencies({ fetch });
    const broker = createGlassHiveInferenceBroker(deps);
    const issued = await broker.issueGrant(issuerAssertion({ adapter: 'openai_responses_v1' }));

    const proxied = await broker.proxyResponses(responsesProxyRequest(issued.grantToken));
    const fetchMock = jest.mocked(deps.fetch);
    const [url, request] = fetchMock.mock.calls[0];
    const headers = new Headers(request?.headers);
    const upstreamBody = JSON.parse(String(request?.body)) as Record<string, string>;

    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.get('authorization')).toBe(`Bearer ${RAW_PERSONAL_KEY}`);
    expect(headers.get('x-attacker-header')).toBeNull();
    expect(upstreamBody.user).toBeUndefined();
    expect(upstreamBody.apiKey).toBeUndefined();
    expect(upstreamBody.baseURL).toBeUndefined();
    expect(upstreamBody.headers).toBeUndefined();
    expect(upstreamBody.input).toBe('Synthetic response request');
    expect(proxied.status).toBe(200);
    expect(proxied.headers['x-request-id']).toBe('resp-[REDACTED]');
    expect(await proxied.response.text()).toContain('[REDACTED]');
    expect(JSON.stringify(jest.mocked(deps.log).mock.calls)).not.toContain(RAW_PERSONAL_KEY);
    expect(deps.getUserKeyValues).toHaveBeenLastCalledWith({
      userId: 'user-a',
      name: EModelEndpoint.openAI,
    });
  });

  it('rejects hosted Responses tools while preserving local function tools', async () => {
    const broker = createGlassHiveInferenceBroker(dependencies());
    const issued = await broker.issueGrant(issuerAssertion({ adapter: 'openai_responses_v1' }));
    const input = responsesProxyRequest(issued.grantToken);

    await expect(
      broker.proxyResponses({
        ...input,
        body: { ...input.body, tools: [{ type: 'web_search' }] },
      }),
    ).rejects.toMatchObject({ code: 'hosted_tool_not_allowed', status: 400 });

    await expect(
      broker.proxyResponses({
        ...input,
        body: {
          ...input.body,
          tools: [{ type: 'function', name: 'local_tool', parameters: { type: 'object' } }],
        },
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('does not allow a grant for one adapter to access the other fixed endpoint', async () => {
    const broker = createGlassHiveInferenceBroker(dependencies());
    const chatGrant = await broker.issueGrant(issuerAssertion());
    const responsesGrant = await broker.issueGrant(
      issuerAssertion({ adapter: 'openai_responses_v1' }),
    );

    await expect(
      broker.proxyResponses(responsesProxyRequest(chatGrant.grantToken)),
    ).rejects.toMatchObject({ code: 'grant_adapter_mismatch', status: 403 });
    await expect(
      broker.proxyChatCompletions(proxyRequest(responsesGrant.grantToken)),
    ).rejects.toMatchObject({ code: 'grant_adapter_mismatch', status: 403 });
    await expect(
      broker.proxyResponses({
        ...responsesProxyRequest(responsesGrant.grantToken),
        body: {
          ...responsesProxyRequest(responsesGrant.grantToken).body,
          model: 'unapproved-model',
        },
      }),
    ).rejects.toMatchObject({ code: 'model_not_allowed', status: 403 });
  });

  it('redacts a credential echoed across upstream streaming chunk boundaries', async () => {
    const splitAt = Math.floor(RAW_PERSONAL_KEY.length / 2);
    const fetch = jest.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: {"debug":"${RAW_PERSONAL_KEY.slice(0, splitAt)}`),
            );
            controller.enqueue(
              new TextEncoder().encode(`${RAW_PERSONAL_KEY.slice(splitAt)}"}\n\n`),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-request-id': `echo-${RAW_PERSONAL_KEY}`,
          },
        },
      ),
    );
    const broker = createGlassHiveInferenceBroker(dependencies({ fetch }));
    const issued = await broker.issueGrant(issuerAssertion());

    const proxied = await broker.proxyChatCompletions(proxyRequest(issued.grantToken));
    const responseText = await proxied.response.text();
    proxied.dispose();

    expect(responseText).toContain('[REDACTED]');
    expect(responseText).not.toContain(RAW_PERSONAL_KEY);
    expect(proxied.headers['x-request-id']).toBe('echo-[REDACTED]');
  });

  it('rejects model escalation, cross-run use, expired grants, revoked grants, and rate limits', async () => {
    const assertGrantActive = jest.fn().mockResolvedValue(undefined);
    const rememberGrantRequest = jest.fn().mockResolvedValue({ accepted: true });
    const deps = dependencies({ assertGrantActive, rememberGrantRequest });
    const broker = createGlassHiveInferenceBroker(deps);
    const issued = await broker.issueGrant(issuerAssertion());

    await expect(
      broker.proxyChatCompletions({
        ...proxyRequest(issued.grantToken),
        body: {
          ...proxyRequest(issued.grantToken).body,
          model: 'unapproved-model',
        },
      }),
    ).rejects.toMatchObject({ code: 'model_not_allowed', status: 403 });
    await expect(
      broker.proxyChatCompletions({
        ...proxyRequest(issued.grantToken),
        runId: 'run-b',
      }),
    ).rejects.toMatchObject({ code: 'grant_scope_mismatch', status: 401 });

    const expiredBroker = createGlassHiveInferenceBroker(
      dependencies({ now: () => NOW_MS + 11 * 60_000 }),
    );
    await expect(
      expiredBroker.proxyChatCompletions(proxyRequest(issued.grantToken)),
    ).rejects.toMatchObject({ code: 'invalid_grant', status: 401 });

    assertGrantActive.mockRejectedValueOnce(new Error('revoked'));
    await expect(
      broker.proxyChatCompletions(proxyRequest(issued.grantToken)),
    ).rejects.toMatchObject({ code: 'grant_inactive', status: 401 });

    rememberGrantRequest.mockResolvedValueOnce({ accepted: false, retryAfterMs: 4_000 });
    await expect(
      broker.proxyChatCompletions(proxyRequest(issued.grantToken)),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterSeconds: 4,
    });
  });

  it('revalidates the user and personal credential on every proxy request', async () => {
    const isUserActive = jest.fn().mockResolvedValue(true);
    const getUserKeyValues = jest
      .fn()
      .mockResolvedValueOnce({ apiKey: RAW_PERSONAL_KEY })
      .mockRejectedValueOnce(new Error('deleted'));
    const broker = createGlassHiveInferenceBroker(dependencies({ isUserActive, getUserKeyValues }));
    const issued = await broker.issueGrant(issuerAssertion());

    await expect(
      broker.proxyChatCompletions(proxyRequest(issued.grantToken)),
    ).rejects.toMatchObject({ code: 'credential_action_required', status: 409 });
    expect(isUserActive).toHaveBeenCalledTimes(2);
    expect(getUserKeyValues).toHaveBeenNthCalledWith(1, {
      userId: 'user-a',
      name: EModelEndpoint.openAI,
    });
    expect(getUserKeyValues).toHaveBeenNthCalledWith(2, {
      userId: 'user-a',
      name: EModelEndpoint.openAI,
    });
  });

  it('uses an operator-owned enterprise route while respecting personal-required policy', async () => {
    const personalRequired = createGlassHiveInferenceBroker(
      dependencies({ getCredentialPolicy: jest.fn().mockResolvedValue('personal_required') }),
    );
    const enterpriseAssertion = issuerAssertion({ route: 'enterprise_route' });

    await expect(personalRequired.issueGrant(enterpriseAssertion)).rejects.toMatchObject({
      code: 'personal_credentials_required',
      status: 409,
    });

    const deps = dependencies();
    const broker = createGlassHiveInferenceBroker(deps);
    const issued = await broker.issueGrant(enterpriseAssertion);
    await broker.proxyChatCompletions(proxyRequest(issued.grantToken));
    const [url, request] = jest.mocked(deps.fetch).mock.calls[0];

    expect(url).toBe('https://enterprise-openai.example.test/v1/chat/completions');
    expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${RAW_ENTERPRISE_KEY}`);
    expect(JSON.stringify(issued)).not.toContain(RAW_ENTERPRISE_KEY);
  });

  it('revokes only a grant matching the signed issuer assertion scope', async () => {
    const revokeGrant = jest.fn().mockResolvedValue(undefined);
    const broker = createGlassHiveInferenceBroker(dependencies({ revokeGrant }));
    const issued = await broker.issueGrant(issuerAssertion());
    const revokeAssertion = issuerAssertion({ action: 'revoke' });

    await expect(broker.revokeGrant(revokeAssertion, issued.grantToken)).resolves.toEqual({
      revoked: true,
      grantId: expect.stringMatching(/^ghcb_infer_/),
    });
    expect(revokeGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-a',
        worker_id: 'worker-a',
        run_id: 'run-a',
      }),
    );

    const wrongRunAssertion = issuerAssertion({ action: 'revoke', runId: 'run-b' });
    await expect(broker.revokeGrant(wrongRunAssertion, issued.grantToken)).rejects.toBeInstanceOf(
      InferenceBrokerError,
    );

    const responsesGrant = await broker.issueGrant(
      issuerAssertion({ adapter: 'openai_responses_v1' }),
    );
    await expect(
      broker.revokeGrant(revokeAssertion, responsesGrant.grantToken),
    ).rejects.toMatchObject({ code: 'grant_scope_mismatch', status: 403 });
  });
});

describe('GlassHive inference broker HTTP boundary', () => {
  let server: Server;

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it('fails every credential-bearing route closed when the broker is unconfigured', async () => {
    const deps = dependencies({ secret: '', proxyBaseUrl: '' });
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/viventium/glasshive/inference', createGlassHiveInferenceBrokerRouter(deps));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;

    const health = await fetch(`${baseUrl}/health`);
    const proxy = await fetch(`${baseUrl}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4.1-mini', input: 'Synthetic request' }),
    });

    expect(await health.json()).toMatchObject({ status: 'unavailable', adapters: [] });
    expect(proxy.status).toBe(503);
    expect(await proxy.json()).toMatchObject({
      error: { code: 'inference_broker_unavailable' },
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('issues, proxies, and revokes through the additive route without exposing credentials', async () => {
    const deps = dependencies();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/viventium/glasshive/inference', createGlassHiveInferenceBrokerRouter(deps));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;

    const assertion = issuerAssertion();
    const issuedResponse = await fetch(`${baseUrl}/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${assertion}` },
    });
    const issued = (await issuedResponse.json()) as IssuedInferenceGrant;

    expect(issuedResponse.status).toBe(201);
    expect(issuedResponse.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(issued)).not.toContain(RAW_PERSONAL_KEY);

    const proxyResponse = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issued.grantToken}`,
        'Content-Type': 'application/json',
        'X-GlassHive-Run-Id': 'run-a',
        'X-GlassHive-Worker-Id': 'worker-a',
      },
      body: JSON.stringify(proxyRequest(issued.grantToken).body),
    });

    expect(proxyResponse.status).toBe(200);
    expect(proxyResponse.headers.get('set-cookie')).toBeNull();
    expect(proxyResponse.headers.get('x-request-id')).toBe('req_synthetic');
    expect(await proxyResponse.text()).toContain('chatcmpl_synthetic');

    const revokeAssertion = issuerAssertion({ action: 'revoke' });
    const revokedResponse = await fetch(`${baseUrl}/grants/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${revokeAssertion}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grantToken: issued.grantToken }),
    });

    expect(revokedResponse.status).toBe(200);
    expect(await revokedResponse.json()).toEqual({ revoked: true, grantId: issued.grantId });
  });

  it('proxies Responses API streaming through its fixed HTTP endpoint', async () => {
    const deps = dependencies({
      fetch: jest.fn().mockResolvedValue(
        new Response('data: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_responses' },
        }),
      ),
    });
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/viventium/glasshive/inference', createGlassHiveInferenceBrokerRouter(deps));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;
    const assertion = issuerAssertion({ adapter: 'openai_responses_v1' });
    const issuedResponse = await fetch(`${baseUrl}/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${assertion}` },
    });
    const issued = (await issuedResponse.json()) as IssuedInferenceGrant;

    const proxyResponse = await fetch(`${baseUrl}/openai/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issued.grantToken}`,
        'Content-Type': 'application/json',
        'X-GlassHive-Run-Id': 'run-a',
        'X-GlassHive-Worker-Id': 'worker-a',
      },
      body: JSON.stringify(responsesProxyRequest(issued.grantToken).body),
    });

    expect(proxyResponse.status).toBe(200);
    expect(proxyResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(await proxyResponse.text()).toContain('response.completed');
    expect(jest.mocked(deps.fetch)).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('keeps an active SSE response alive beyond the upstream header deadline', async () => {
    const encoder = new TextEncoder();
    const deps = dependencies({
      upstreamTimeoutMs: 1000,
      responseIdleTimeoutMs: 1000,
      fetch: jest.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            async start(controller) {
              for (let index = 0; index < 6; index += 1) {
                controller.enqueue(encoder.encode(`data: {"index":${index}}\n\n`));
                await new Promise((resolve) => setTimeout(resolve, 300));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    });
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/viventium/glasshive/inference', createGlassHiveInferenceBrokerRouter(deps));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;
    const issuedResponse = await fetch(`${baseUrl}/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${issuerAssertion({ adapter: 'openai_responses_v1' })}` },
    });
    const issued = (await issuedResponse.json()) as IssuedInferenceGrant;
    const startedAt = Date.now();
    const proxyResponse = await fetch(`${baseUrl}/openai/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issued.grantToken}`,
        'Content-Type': 'application/json',
        'X-GlassHive-Run-Id': 'run-a',
        'X-GlassHive-Worker-Id': 'worker-a',
      },
      body: JSON.stringify(responsesProxyRequest(issued.grantToken).body),
    });

    expect(proxyResponse.status).toBe(200);
    expect(await proxyResponse.text()).toContain('"index":5');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
  });

  it('rejects an oversized non-stream response without buffering it unboundedly', async () => {
    const deps = dependencies({
      maxResponseBytes: 1024,
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ output: 'x'.repeat(2048) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/viventium/glasshive/inference', createGlassHiveInferenceBrokerRouter(deps));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;
    const issuedResponse = await fetch(`${baseUrl}/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${issuerAssertion()}` },
    });
    const issued = (await issuedResponse.json()) as IssuedInferenceGrant;
    const proxyResponse = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issued.grantToken}`,
        'Content-Type': 'application/json',
        'X-GlassHive-Run-Id': 'run-a',
        'X-GlassHive-Worker-Id': 'worker-a',
      },
      body: JSON.stringify(proxyRequest(issued.grantToken).body),
    });

    expect(proxyResponse.status).toBe(502);
    expect(await proxyResponse.json()).toMatchObject({
      error: { code: 'upstream_response_too_large' },
    });
  });

  it('returns stable redacted errors and advertises only the proven adapters', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/viventium/glasshive/inference',
      createGlassHiveInferenceBrokerRouter(dependencies()),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;

    const health = await fetch(`${baseUrl}/health`);
    const healthBody = await health.json();
    const rejected = await fetch(`${baseUrl}/grants`, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid' },
    });
    const rejectedText = await rejected.text();

    expect(healthBody).toEqual({
      status: 'ok',
      service: 'glasshive-inference-broker',
      adapters: [
        {
          id: 'openai_chat_completions_v1',
          provider: 'openai',
          paths: ['/openai/v1/chat/completions'],
          supportsStreaming: true,
        },
        {
          id: 'openai_responses_v1',
          provider: 'openai',
          paths: ['/openai/v1/responses'],
          supportsStreaming: true,
        },
      ],
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(rejectedText)).toEqual({
      error: {
        code: 'invalid_issuer_assertion',
        message: 'Invalid GlassHive inference issuer assertion',
      },
    });
    expect(rejectedText).not.toContain(RAW_PERSONAL_KEY);
    expect(rejectedText).not.toContain(MASTER_SECRET);
  });

  it('loads harmlessly when disabled and fails grant issuance closed', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/viventium/glasshive/inference',
      createGlassHiveInferenceBrokerRouter(dependencies({ secret: '', proxyBaseUrl: '' })),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;

    const health = await fetch(`${baseUrl}/health`);
    const issued = await fetch(`${baseUrl}/grants`, {
      method: 'POST',
      headers: { Authorization: 'Bearer unavailable' },
    });

    expect(await health.json()).toEqual({
      status: 'unavailable',
      service: 'glasshive-inference-broker',
      adapters: [],
    });
    expect(issued.status).toBe(503);
    expect(await issued.json()).toEqual({
      error: {
        code: 'inference_broker_unavailable',
        message: 'GlassHive inference broker is unavailable',
      },
    });
  });

  it('fails health and signing closed when the broker secret is shorter than 32 bytes', async () => {
    const shortSecret = 'x'.repeat(31);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/viventium/glasshive/inference',
      createGlassHiveInferenceBrokerRouter(dependencies({ secret: shortSecret })),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/viventium/glasshive/inference`;

    expect(() =>
      mintInferenceIssuerAssertion({
        secret: shortSecret,
        tenantId: 'tenant-a',
        userId: 'user-a',
        workerId: 'worker-a',
        runId: 'run-a',
        provider: 'openai',
        route: 'personal_api_key',
        adapter: 'openai_responses_v1',
        models: ['gpt-4.1-mini'],
        action: 'issue',
        nowMs: NOW_MS,
      }),
    ).toThrow('GlassHive inference broker is unavailable');
    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({
      status: 'unavailable',
      service: 'glasshive-inference-broker',
      adapters: [],
    });
  });
});
