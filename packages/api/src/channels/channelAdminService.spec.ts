/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Prove admin configuration is secret-safe, restartable, and truthful about worker health.
 * === VIVENTIUM END ===
 */

import { ChannelAdminService, ChannelCredentialVault, ChannelRuntime } from './index';
import type {
  ChannelConnectionRecord,
  ChannelConnectionRepository,
  ChannelTransport,
} from './index';

class MemoryConnectionRepository implements ChannelConnectionRepository {
  readonly records = new Map<string, ChannelConnectionRecord>();

  async list(): Promise<ChannelConnectionRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async findByChannel(channel: ChannelConnectionRecord['channel']) {
    const record = this.records.get(channel);
    return record ? { ...record } : null;
  }

  async findByCallbackId(callbackId: string) {
    const record = [...this.records.values()].find(
      (record) => record.callbackId === callbackId || record.pendingCallbackId === callbackId,
    );
    return record ? { ...record } : null;
  }

  async save(record: ChannelConnectionRecord) {
    this.records.set(record.channel, { ...record });
    return { ...record };
  }

  async saveIfGeneration(
    expectedGeneration: string | null,
    record: ChannelConnectionRecord,
    expectedPendingGeneration?: string | null,
  ) {
    const current = this.records.get(record.channel);
    if (
      (current?.configGeneration ?? null) !== expectedGeneration ||
      (expectedPendingGeneration !== undefined &&
        (current?.pendingConfigGeneration ?? null) !== expectedPendingGeneration)
    ) {
      return null;
    }
    return await this.save(record);
  }

  async stageActivation(
    expectedGeneration: string,
    record: ChannelConnectionRecord,
    expectedPendingGeneration?: string | null,
  ) {
    const current = this.records.get(record.channel);
    if (
      current?.configGeneration !== expectedGeneration ||
      (expectedPendingGeneration !== undefined &&
        (current.pendingConfigGeneration ?? null) !== expectedPendingGeneration) ||
      (current.state === 'connected' && current.activeGeneration === expectedGeneration)
    ) {
      return null;
    }
    return await this.save(record);
  }

  async stageWhatsAppCandidate(
    expectedActiveGeneration: string | null,
    expectedPendingGeneration: string | null,
    record: ChannelConnectionRecord,
  ) {
    const current = this.records.get('whatsapp');
    if (
      current?.configGeneration !== expectedActiveGeneration ||
      (current.pendingConfigGeneration ?? null) !== expectedPendingGeneration ||
      current.state === 'disconnected'
    ) {
      return null;
    }
    return await this.save(record);
  }

  async saveWhatsAppCandidate(
    expectedActiveGeneration: string | null,
    expectedPendingGeneration: string,
    record: ChannelConnectionRecord,
  ) {
    const current = this.records.get('whatsapp');
    if (
      (current?.configGeneration ?? null) !== expectedActiveGeneration ||
      current?.pendingConfigGeneration !== expectedPendingGeneration
    ) {
      return null;
    }
    return await this.save(record);
  }

  async promoteWhatsAppCandidate(
    expectedActiveGeneration: string | null,
    expectedPendingGeneration: string,
    record: ChannelConnectionRecord,
  ) {
    const current = this.records.get('whatsapp');
    if (
      current?.configGeneration !== expectedActiveGeneration ||
      current.pendingConfigGeneration !== expectedPendingGeneration
    ) {
      return null;
    }
    return await this.save(record);
  }
}

function createVault() {
  return new ChannelCredentialVault(
    async (plaintext) => `cipher:${Buffer.from(plaintext).toString('base64')}`,
    async (ciphertext) => Buffer.from(ciphertext.replace('cipher:', ''), 'base64').toString('utf8'),
  );
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createTelegramTransport(events: string[], testOk = true): ChannelTransport {
  return {
    channel: 'telegram',
    start: async (connection) => events.push(`start:${connection.accountId}`),
    stop: async (accountId) => events.push(`stop:${accountId}`),
    test: async () =>
      testOk
        ? { ok: true, displayName: '@synthetic_bot' }
        : { ok: false, issueCode: 'synthetic_failure' },
    send: async () => undefined,
  };
}

describe('ChannelAdminService', () => {
  it('lists all supported channels without credential or callback identifiers', async () => {
    const repository = new MemoryConnectionRepository();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'default',
      displayName: '@synthetic_bot',
      encryptedCredentials: 'cipher:secret',
      callbackId: 'private-callback-id',
    });
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime: new ChannelRuntime(),
      randomId: () => 'synthetic-random-id',
    });

    const result = await service.list();

    expect(result).toEqual([
      { channel: 'telegram', state: 'connected', displayName: '@synthetic_bot' },
      { channel: 'slack', state: 'not_configured' },
      { channel: 'whatsapp', state: 'not_configured' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private-callback-id');
  });

  it('connects and verifies through a registered loopback transport', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    const events: string[] = [];
    runtime.register(createTelegramTransport(events));
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      randomId: () => 'synthetic-random-id',
    });

    const summary = await service.connect(
      'telegram',
      { botToken: 'synthetic-token', dmPolicy: 'PAIRING' },
      'admin-1',
    );

    expect(summary).toEqual({
      channel: 'telegram',
      state: 'connected',
      displayName: '@synthetic_bot',
    });
    expect(events).toEqual(['start:default']);
    expect(repository.records.get('telegram')?.encryptedCredentials).not.toContain(
      'synthetic-token',
    );
  });

  it('stores valid credentials but truthfully reports a missing production transport', async () => {
    const repository = new MemoryConnectionRepository();
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime: new ChannelRuntime(),
      randomId: () => 'synthetic-random-id',
    });

    const summary = await service.connect(
      'slack',
      { appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic' },
      'admin-1',
    );

    expect(summary).toEqual({
      channel: 'slack',
      state: 'needs_vendor_step',
      issueCode: 'transport_unavailable',
    });
  });

  it('does not leave a worker running when credential verification fails', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    const events: string[] = [];
    runtime.register(createTelegramTransport(events, false));
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      randomId: () => 'synthetic-random-id',
    });

    const summary = await service.connect('telegram', { botToken: 'synthetic-token' }, 'admin-1');

    expect(summary).toEqual({
      channel: 'telegram',
      state: 'degraded',
      issueCode: 'synthetic_failure',
    });
    expect(events).toEqual([]);
  });

  it('keeps a working connection intact and rejects a failed repair explicitly', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const previousCipher = await vault.encrypt({ botToken: 'working-token' });
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: previousCipher,
      callbackId: 'opaque-1',
      displayName: '@working_bot',
    });
    const runtime = new ChannelRuntime();
    runtime.register(createTelegramTransport([], false));
    const service = new ChannelAdminService({ repository, vault, runtime });

    await expect(
      service.connect('telegram', { botToken: 'bad-token' }, 'user-1'),
    ).rejects.toMatchObject({
      status: 409,
      issueCode: 'synthetic_failure',
    });
    expect(repository.records.get('telegram')?.encryptedCredentials).toBe(previousCipher);
    expect(repository.records.get('telegram')?.state).toBe('connected');
  });

  it('starts and persists the provider-verified account namespace', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    const events: string[] = [];
    runtime.register({
      channel: 'telegram',
      test: async () => ({ ok: true, accountId: 'bot-verified' }),
      start: async (connection) => events.push(`start:${connection.accountId}`),
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({ repository, vault: createVault(), runtime });
    await service.connect('telegram', { botToken: 'synthetic' }, 'user-1');
    expect(events).toEqual(['start:bot-verified']);
    expect(repository.records.get('telegram')?.accountId).toBe('bot-verified');
  });

  it('activates replacement credentials for a same-account repair before reporting Connected', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: await vault.encrypt({ botToken: 'old-token' }),
      callbackId: 'opaque-1',
      configGeneration: 'generation-1',
      activeGeneration: 'generation-1',
    });
    const starts: string[] = [];
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'telegram',
      test: async () => ({ ok: true, accountId: 'bot-1' }),
      start: async (connection) => {
        starts.push(connection.credentials.botToken);
        return true;
      },
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      randomGeneration: () => 'generation-2',
    });
    await expect(
      service.connect('telegram', { botToken: 'new-token' }, 'user-1'),
    ).resolves.toMatchObject({ state: 'connected' });
    expect(starts).toEqual(['new-token']);
    expect(repository.records.get('telegram')).toMatchObject({
      configGeneration: 'generation-2',
      activeGeneration: 'generation-2',
      state: 'connected',
    });
  });

  it('reports activation pending when another process owns the worker, then reconciliation completes it', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    let canActivate = false;
    runtime.register({
      channel: 'telegram',
      test: async () => ({ ok: true, accountId: 'bot-1' }),
      start: async () => canActivate,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      randomGeneration: () => 'generation-2',
    });
    await expect(service.connect('telegram', { botToken: 'new-token' }, 'user-1')).resolves.toEqual(
      {
        channel: 'telegram',
        state: 'verifying',
        issueCode: 'activation_pending',
      },
    );
    expect(repository.records.get('telegram')?.state).toBe('verifying');
    canActivate = true;
    await service.restore();
    expect(repository.records.get('telegram')).toMatchObject({
      state: 'connected',
      activeGeneration: 'generation-2',
    });
  });

  it('serializes concurrent repairs so a stale activation cannot stop the newer generation', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    let finishFirst;
    const firstStart = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const starts: string[] = [];
    runtime.register({
      channel: 'telegram',
      test: async () => ({ ok: true, accountId: 'bot-1' }),
      start: async (connection) => {
        starts.push(connection.credentials.botToken);
        if (starts.length === 1) {
          await firstStart;
        }
        return true;
      },
      stop: async () => undefined,
      send: async () => undefined,
    });
    const generations = ['generation-2', 'generation-3'];
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      randomGeneration: () => generations.shift() || 'unexpected',
    });
    const repair2 = service.connect('telegram', { botToken: 'token-2' }, 'user-1');
    const repair3 = service.connect('telegram', { botToken: 'token-3' }, 'user-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(starts).toEqual(['token-2']);
    finishFirst();
    await expect(Promise.all([repair2, repair3])).resolves.toEqual([
      expect.objectContaining({ state: 'connected' }),
      expect.objectContaining({ state: 'connected' }),
    ]);
    expect(starts).toEqual(['token-2', 'token-3']);
    expect(repository.records.get('telegram')).toMatchObject({
      state: 'connected',
      configGeneration: 'generation-3',
      activeGeneration: 'generation-3',
    });
  });

  it('derives WhatsApp callback URLs only from the trusted server origin', async () => {
    const repository = new MemoryConnectionRepository();
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime: new ChannelRuntime(),
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'opaque-connection-id',
    });
    const input = {
      phoneNumberId: 'phone-1',
      businessAccountId: 'business-1',
      accessToken: 'synthetic-access',
      appSecret: 'synthetic-app-secret',
      verifyToken: 'synthetic-verify',
      webhookUrl: 'https://attacker.example.com',
    };

    await expect(service.connect('whatsapp', input, 'admin-1')).rejects.toThrow(
      'webhookUrl is server-managed',
    );
    delete input.webhookUrl;
    const summary = await service.connect('whatsapp', input, 'admin-1');
    expect(summary.callbackUrl).toBe(
      'https://viventium.example.com/api/viventium/channels/whatsapp/webhook/opaque-connection-id',
    );
  });

  it('uses the validated public HTTPS address supplied in Settings when the runtime has no public origin', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-1', displayName: 'Synthetic Business' }),
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      randomId: () => '0123456789abcdef0123456789abcdef',
    });

    const summary = await service.connect(
      'whatsapp',
      {
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'synthetic-access',
        appSecret: 'synthetic-app-secret',
        verifyToken: 'synthetic-verify',
        publicBaseUrl: 'https://api.example.test/',
      },
      'admin-1',
    );

    expect(summary).toMatchObject({
      state: 'needs_vendor_step',
      issueCode: 'webhook_verification_required',
      callbackUrl:
        'https://api.example.test/api/viventium/channels/whatsapp/webhook/0123456789abcdef0123456789abcdef',
    });
    expect(repository.records.get('whatsapp')).toMatchObject({
      publicBaseUrl: 'https://api.example.test',
    });
  });

  it('reconnects WhatsApp after disconnect without requiring the disconnected row to be deleted', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'disconnected',
      accountId: 'phone-old',
      encryptedCredentials: await vault.encrypt({}),
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      publicBaseUrl: null,
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
      pendingConfigGeneration: null,
    });
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-new', displayName: 'Synthetic Business' }),
      start: async () => true,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      randomGeneration: () => 'generation-reconnected',
    });

    await expect(
      service.connect(
        'whatsapp',
        {
          phoneNumberId: 'phone-new',
          businessAccountId: 'business-new',
          accessToken: 'access-new',
          appSecret: 'secret-new',
          verifyToken: 'verify-new',
        },
        'admin-2',
      ),
    ).resolves.toMatchObject({
      state: 'needs_vendor_step',
      issueCode: 'webhook_verification_required',
      callbackUrl:
        'https://viventium.example.com/api/viventium/channels/whatsapp/webhook/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'needs_vendor_step',
      accountId: 'phone-new',
      callbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      configGeneration: 'generation-reconnected',
      activeGeneration: null,
    });
    expect(repository.records.get('whatsapp')?.pendingConfigGeneration).toBeUndefined();
  });

  it('keeps WhatsApp pending until Meta verifies the callback, then restores worker readiness', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    const events: string[] = [];
    runtime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-1', displayName: 'Synthetic Business' }),
      start: async (connection) => events.push(`start:${connection.accountId}`),
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => '0123456789abcdef0123456789abcdef',
    });
    const summary = await service.connect(
      'whatsapp',
      {
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'synthetic',
        appSecret: 'synthetic-secret',
        verifyToken: 'synthetic-verify',
      },
      'user-1',
    );
    expect(summary).toMatchObject({
      state: 'needs_vendor_step',
      issueCode: 'webhook_verification_required',
    });
    expect(events).toEqual([]);
    await expect(
      service.markWhatsAppWebhookVerified('0123456789abcdef0123456789abcdef'),
    ).resolves.toBe(true);
    expect(repository.records.get('whatsapp')?.state).toBe('verifying');
    expect(events).toEqual([]);
    await expect(service.test('whatsapp')).resolves.toMatchObject({
      ok: false,
      channel: { state: 'needs_vendor_step', issueCode: 'signed_callback_pending' },
    });
    expect(events).toEqual([]);
    await expect(
      service.markWhatsAppSignedCallbackVerified('0123456789abcdef0123456789abcdef'),
    ).resolves.toBe(true);
    expect(repository.records.get('whatsapp')?.state).toBe('connected');
    expect(events).toEqual(['start:phone-1']);
    await expect(
      service.markWhatsAppSignedCallbackVerified('0123456789abcdef0123456789abcdef'),
    ).resolves.toBe(true);
    expect(events).toEqual(['start:phone-1']);
  });

  it('stages a WhatsApp repair without changing the active credentials, callback, state, or worker', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const activeCipher = await vault.encrypt({
      phoneNumberId: 'phone-old',
      businessAccountId: 'business-old',
      accessToken: 'access-old',
      appSecret: 'secret-old',
      verifyToken: 'verify-old',
    });
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: activeCipher,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
    });
    const events: string[] = [];
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-new' }),
      start: async () => {
        events.push('start');
        return true;
      },
      stop: async () => {
        events.push('stop');
      },
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      randomGeneration: () => 'generation-new',
    });

    await expect(
      service.connect(
        'whatsapp',
        {
          phoneNumberId: 'phone-new',
          businessAccountId: 'business-new',
          accessToken: 'access-new',
          appSecret: 'secret-new',
          verifyToken: 'verify-new',
        },
        'user-1',
      ),
    ).resolves.toMatchObject({
      state: 'needs_vendor_step',
      issueCode: 'replacement_webhook_verification_required',
      callbackUrl: expect.stringContaining('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    });

    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: activeCipher,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pendingConfigGeneration: 'generation-new',
    });
    expect(events).toEqual([]);
    await expect(service.list()).resolves.toContainEqual(
      expect.objectContaining({
        channel: 'whatsapp',
        state: 'needs_vendor_step',
        issueCode: 'replacement_webhook_verification_required',
        callbackUrl: expect.stringContaining('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      }),
    );
    await expect(service.availability()).resolves.toContainEqual({
      channel: 'whatsapp',
      available: true,
    });
  });

  it('keeps a pending WhatsApp replacement visible after testing the active connection', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-active',
      encryptedCredentials: await vault.encrypt({
        phoneNumberId: 'phone-active',
        accessToken: 'access-active',
        appSecret: 'secret-active',
        verifyToken: 'verify-active',
      }),
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-active',
      activeGeneration: 'generation-active',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
      pendingEncryptedCredentials: await vault.encrypt({
        phoneNumberId: 'phone-pending',
        accessToken: 'access-pending',
        appSecret: 'secret-pending',
        verifyToken: 'verify-pending',
      }),
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pendingAccountId: 'phone-pending',
      pendingConfigGeneration: 'generation-pending',
      pendingWebhookVerifiedAt: null,
    });
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-active' }),
      start: async () => true,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomGeneration: () => 'generation-tested',
    });

    await expect(service.test('whatsapp')).resolves.toMatchObject({
      ok: true,
      channel: {
        state: 'needs_vendor_step',
        issueCode: 'replacement_webhook_verification_required',
        callbackUrl:
          'https://viventium.example.com/api/viventium/channels/whatsapp/webhook/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      configGeneration: 'generation-tested',
      activeGeneration: 'generation-tested',
      pendingConfigGeneration: 'generation-pending',
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('keeps the active WhatsApp connection running when pending signed-callback activation fails', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const activeCipher = await vault.encrypt({
      phoneNumberId: 'phone-old',
      businessAccountId: 'business-old',
      accessToken: 'access-old',
      appSecret: 'secret-old',
      verifyToken: 'verify-old',
    });
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: activeCipher,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
    });
    let testCount = 0;
    const events: string[] = [];
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () =>
        ++testCount === 1
          ? { ok: true, accountId: 'phone-new' }
          : { ok: false, issueCode: 'invalid_credentials' },
      start: async () => {
        events.push('start');
        return true;
      },
      stop: async () => {
        events.push('stop');
      },
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      randomGeneration: () => 'generation-new',
    });
    await service.connect(
      'whatsapp',
      {
        phoneNumberId: 'phone-new',
        businessAccountId: 'business-new',
        accessToken: 'access-new',
        appSecret: 'secret-new',
        verifyToken: 'verify-new',
      },
      'user-1',
    );
    await expect(
      service.markWhatsAppWebhookVerified('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    ).resolves.toBe(true);
    await expect(
      service.markWhatsAppSignedCallbackVerified('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    ).resolves.toBe(false);

    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: activeCipher,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      pendingConfigGeneration: 'generation-new',
    });
    expect(events).toEqual([]);
  });

  it('keeps repeated active WhatsApp GET verification idempotent', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-1',
      encryptedCredentials: await vault.encrypt({ appSecret: 'secret', verifyToken: 'verify' }),
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-1',
      activeGeneration: 'generation-1',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
    });
    const service = new ChannelAdminService({ repository, vault, runtime: new ChannelRuntime() });

    await expect(
      service.markWhatsAppWebhookVerified('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    ).resolves.toBe(true);
    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      activeGeneration: 'generation-1',
    });
    expect(repository.records.get('whatsapp')?.issueCode).toBeUndefined();
  });

  it('allows only one stale concurrent WhatsApp candidate to stage', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: await vault.encrypt({ appSecret: 'old', verifyToken: 'old' }),
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
    });
    let releaseTests;
    const testBarrier = new Promise<void>((resolve) => {
      releaseTests = resolve;
    });
    let testCalls = 0;
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => {
        testCalls += 1;
        await testBarrier;
        return { ok: true, accountId: 'phone-new' };
      },
      start: async () => true,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const callbacks = ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccc'];
    const generations = ['generation-new-1', 'generation-new-2'];
    const serviceA = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => callbacks.shift() || '',
      randomGeneration: () => generations.shift() || '',
    });
    const serviceB = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => callbacks.shift() || '',
      randomGeneration: () => generations.shift() || '',
    });
    const input = {
      phoneNumberId: 'phone-new',
      businessAccountId: 'business-new',
      accessToken: 'access-new',
      appSecret: 'secret-new',
      verifyToken: 'verify-new',
    };
    const attempts = [
      serviceA.connect('whatsapp', input, 'user-1'),
      serviceB.connect('whatsapp', input, 'user-2'),
    ];
    while (testCalls < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseTests();
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rolls back the active WhatsApp record and worker when final activation persistence loses CAS', async () => {
    class FinalCasLossRepository extends MemoryConnectionRepository {
      private loseNextFinalSave = true;
      override async saveIfGeneration(expectedGeneration: string, record: ChannelConnectionRecord) {
        if (expectedGeneration === 'generation-new' && this.loseNextFinalSave) {
          this.loseNextFinalSave = false;
          return null;
        }
        return await super.saveIfGeneration(expectedGeneration, record);
      }
    }
    const repository = new FinalCasLossRepository();
    const vault = createVault();
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: await vault.encrypt({
        phoneNumberId: 'phone-old',
        businessAccountId: 'business-old',
        accessToken: 'old',
        appSecret: 'old',
        verifyToken: 'old',
      }),
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
    });
    const events: string[] = [];
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-new' }),
      start: async (connection) => {
        events.push(`start:${connection.credentials.accessToken}`);
        return true;
      },
      stop: async (accountId) => {
        events.push(`stop:${accountId}`);
      },
      send: async () => undefined,
    });
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      randomGeneration: () => 'generation-new',
    });
    await service.connect(
      'whatsapp',
      {
        phoneNumberId: 'phone-new',
        businessAccountId: 'business-new',
        accessToken: 'new',
        appSecret: 'new',
        verifyToken: 'new',
      },
      'user-1',
    );
    await service.markWhatsAppWebhookVerified('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await expect(
      service.markWhatsAppSignedCallbackVerified('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    ).resolves.toBe(false);

    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      accountId: 'phone-old',
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
    });
    expect(events).toEqual(['start:new', 'stop:phone-new', 'start:old']);
  });

  it('does not let a slower process downgrade an already-activated WhatsApp generation', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'verifying',
      accountId: 'phone-1',
      encryptedCredentials: await vault.encrypt({
        phoneNumberId: 'phone-1',
        businessAccountId: 'business-1',
        accessToken: 'synthetic',
        appSecret: 'synthetic-secret',
        verifyToken: 'synthetic-verify',
      }),
      callbackId: '0123456789abcdef0123456789abcdef',
      webhookVerifiedAt: new Date(),
      configGeneration: 'generation-1',
      activeGeneration: null,
    });
    let finishSlowTest;
    const slowTest = new Promise<void>((resolve) => {
      finishSlowTest = resolve;
    });
    const startsA: string[] = [];
    const startsB: string[] = [];
    const runtimeA = new ChannelRuntime();
    runtimeA.register({
      channel: 'whatsapp',
      test: async () => {
        await slowTest;
        return { ok: true, accountId: 'phone-1' };
      },
      start: async () => {
        startsA.push('start');
        return true;
      },
      stop: async () => undefined,
      send: async () => undefined,
    });
    const runtimeB = new ChannelRuntime();
    runtimeB.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-1' }),
      start: async () => {
        startsB.push('start');
        return true;
      },
      stop: async () => undefined,
      send: async () => undefined,
    });
    const serviceA = new ChannelAdminService({ repository, vault, runtime: runtimeA });
    const serviceB = new ChannelAdminService({ repository, vault, runtime: runtimeB });
    const slow = serviceA.markWhatsAppSignedCallbackVerified('0123456789abcdef0123456789abcdef');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      serviceB.markWhatsAppSignedCallbackVerified('0123456789abcdef0123456789abcdef'),
    ).resolves.toBe(true);
    finishSlowTest();
    await expect(slow).resolves.toBe(true);
    expect(startsA).toEqual([]);
    expect(startsB).toEqual(['start']);
    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      configGeneration: 'generation-1',
      activeGeneration: 'generation-1',
    });
  });

  it('does not let stale active WhatsApp verification erase a newer pending replacement', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const activeCiphertext = await vault.encrypt({
      phoneNumberId: 'phone-old',
      businessAccountId: 'business-old',
      accessToken: 'access-old',
      appSecret: 'secret-old',
      verifyToken: 'verify-old',
    });
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-old',
      encryptedCredentials: activeCiphertext,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      webhookVerifiedAt: null,
      webhookSignedVerifiedAt: null,
    });
    const decryptEntered = createDeferred();
    const releaseDecrypt = createDeferred();
    const delayedVault = new ChannelCredentialVault(
      async (plaintext) => `cipher:${Buffer.from(plaintext).toString('base64')}`,
      async (ciphertext) => {
        decryptEntered.resolve();
        await releaseDecrypt.promise;
        return Buffer.from(ciphertext.replace('cipher:', ''), 'base64').toString('utf8');
      },
    );
    const staleVerification = new ChannelAdminService({
      repository,
      vault: delayedVault,
      runtime: new ChannelRuntime(),
      trustedPublicApiUrl: 'https://viventium.example.com',
    }).markWhatsAppWebhookVerified('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await decryptEntered.promise;
    const replacementRuntime = new ChannelRuntime();
    replacementRuntime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-new' }),
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const pendingCiphertext = await vault.encrypt({
      phoneNumberId: 'phone-new',
      businessAccountId: 'business-new',
      accessToken: 'access-new',
      appSecret: 'secret-new',
      verifyToken: 'verify-new',
    });
    await new ChannelAdminService({
      repository,
      vault,
      runtime: replacementRuntime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      randomGeneration: () => 'generation-new',
    }).connect(
      'whatsapp',
      {
        phoneNumberId: 'phone-new',
        businessAccountId: 'business-new',
        accessToken: 'access-new',
        appSecret: 'secret-new',
        verifyToken: 'verify-new',
      },
      'admin-2',
    );
    releaseDecrypt.resolve();

    await expect(staleVerification).resolves.toBe(false);
    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      encryptedCredentials: activeCiphertext,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: 'generation-old',
      pendingEncryptedCredentials: pendingCiphertext,
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pendingConfigGeneration: 'generation-new',
    });
  });

  it('keeps credentials and callback identity immutable while a test advances the observation generation', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const encryptedCredentials = await vault.encrypt({
      phoneNumberId: 'phone-1',
      accessToken: 'access-1',
      appSecret: 'secret-1',
      verifyToken: 'verify-1',
    });
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'needs_vendor_step',
      accountId: 'phone-1',
      encryptedCredentials,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-1',
      activeGeneration: null,
      webhookVerifiedAt: null,
      webhookSignedVerifiedAt: null,
      pendingConfigGeneration: null,
      pendingCallbackId: null,
    });
    const testEntered = createDeferred();
    const releaseTest = createDeferred();
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'whatsapp',
      test: async () => {
        testEntered.resolve();
        await releaseTest.promise;
        return { ok: true, accountId: 'phone-1' };
      },
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const testing = new ChannelAdminService({
      repository,
      vault,
      runtime,
      randomGeneration: () => 'generation-tested',
    }).test('whatsapp');

    await testEntered.promise;
    await new ChannelAdminService({
      repository,
      vault,
      runtime: new ChannelRuntime(),
    }).markWhatsAppWebhookVerified('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    releaseTest.resolve();
    await testing;

    expect(repository.records.get('whatsapp')).toMatchObject({
      accountId: 'phone-1',
      encryptedCredentials,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-tested',
      activeGeneration: null,
      pendingConfigGeneration: null,
      pendingCallbackId: null,
    });
  });

  it('does not let a stale active WhatsApp signed callback undo a newer disconnect', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const priorCiphertext = await vault.encrypt({
      phoneNumberId: 'phone-old',
      businessAccountId: 'business-old',
      accessToken: 'access-old',
      appSecret: 'secret-old',
      verifyToken: 'verify-old',
    });
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'verifying',
      accountId: 'phone-old',
      encryptedCredentials: priorCiphertext,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-old',
      activeGeneration: null,
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: null,
    });
    const testEntered = createDeferred();
    const releaseTest = createDeferred();
    const staleEvents: string[] = [];
    const staleRuntime = new ChannelRuntime();
    staleRuntime.register({
      channel: 'whatsapp',
      test: async () => {
        testEntered.resolve();
        await releaseTest.promise;
        return { ok: false, issueCode: 'invalid_credentials' };
      },
      start: async () => staleEvents.push('start:old'),
      stop: async () => staleEvents.push('stop:old'),
      send: async () => undefined,
    });
    const staleCallback = new ChannelAdminService({
      repository,
      vault,
      runtime: staleRuntime,
    }).markWhatsAppSignedCallbackVerified('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await testEntered.promise;
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true }),
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    await new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'cccccccccccccccccccccccccccccccc',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('whatsapp');
    releaseTest.resolve();

    await expect(staleCallback).resolves.toBe(false);
    const current = repository.records.get('whatsapp');
    expect(current).toMatchObject({
      state: 'disconnected',
      callbackId: 'cccccccccccccccccccccccccccccccc',
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
    });
    expect(current?.encryptedCredentials).not.toBe(priorCiphertext);
    expect(await vault.decrypt(current?.encryptedCredentials ?? '')).toEqual({});
    expect(staleEvents).toEqual([]);
  });

  it('keeps the newest pending WhatsApp callback when an older candidate finishes testing', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const activeCiphertext = await vault.encrypt({
      phoneNumberId: 'phone-active',
      accessToken: 'access-active',
      appSecret: 'secret-active',
      verifyToken: 'verify-active',
    });
    const pendingCiphertext = await vault.encrypt({
      phoneNumberId: 'phone-pending-1',
      accessToken: 'access-pending-1',
      appSecret: 'secret-pending-1',
      verifyToken: 'verify-pending-1',
    });
    repository.records.set('whatsapp', {
      channel: 'whatsapp',
      state: 'connected',
      accountId: 'phone-active',
      encryptedCredentials: activeCiphertext,
      callbackId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      configGeneration: 'generation-active',
      activeGeneration: 'generation-active',
      webhookVerifiedAt: new Date(),
      webhookSignedVerifiedAt: new Date(),
      pendingEncryptedCredentials: pendingCiphertext,
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pendingAccountId: 'phone-pending-1',
      pendingConfigGeneration: 'generation-pending-1',
      pendingWebhookVerifiedAt: new Date(),
    });
    const testEntered = createDeferred();
    const releaseTest = createDeferred();
    const staleRuntime = new ChannelRuntime();
    staleRuntime.register({
      channel: 'whatsapp',
      test: async () => {
        testEntered.resolve();
        await releaseTest.promise;
        return { ok: true, accountId: 'phone-pending-1' };
      },
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const staleActivation = new ChannelAdminService({
      repository,
      vault,
      runtime: staleRuntime,
    }).markWhatsAppSignedCallbackVerified('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    await testEntered.promise;
    const replacementRuntime = new ChannelRuntime();
    replacementRuntime.register({
      channel: 'whatsapp',
      test: async () => ({ ok: true, accountId: 'phone-pending-2' }),
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    await new ChannelAdminService({
      repository,
      vault,
      runtime: replacementRuntime,
      trustedPublicApiUrl: 'https://viventium.example.com',
      randomId: () => 'cccccccccccccccccccccccccccccccc',
      randomGeneration: () => 'generation-pending-2',
    }).connect(
      'whatsapp',
      {
        phoneNumberId: 'phone-pending-2',
        businessAccountId: 'business-pending-2',
        accessToken: 'access-pending-2',
        appSecret: 'secret-pending-2',
        verifyToken: 'verify-pending-2',
      },
      'admin-2',
    );
    const newestPendingCiphertext = repository.records.get('whatsapp')?.pendingEncryptedCredentials;
    releaseTest.resolve();

    await expect(staleActivation).resolves.toBe(false);
    expect(repository.records.get('whatsapp')).toMatchObject({
      state: 'connected',
      encryptedCredentials: activeCiphertext,
      configGeneration: 'generation-active',
      activeGeneration: 'generation-active',
      pendingEncryptedCredentials: newestPendingCiphertext,
      pendingCallbackId: 'cccccccccccccccccccccccccccccccc',
      pendingConfigGeneration: 'generation-pending-2',
    });
  });

  it('disconnects a worker, destroys stored credentials, and persists disconnected state', async () => {
    const repository = new MemoryConnectionRepository();
    const runtime = new ChannelRuntime();
    const events: string[] = [];
    runtime.register(createTelegramTransport(events));
    let randomCall = 0;
    const service = new ChannelAdminService({
      repository,
      vault: createVault(),
      runtime,
      randomId: () => `opaque-${++randomCall}`,
    });
    await service.connect('telegram', { botToken: 'synthetic-token' }, 'admin-1');

    const summary = await service.disconnect('telegram');

    expect(summary).toEqual({ channel: 'telegram', state: 'disconnected' });
    expect(events).toEqual(['start:default', 'stop:default']);
    const record = repository.records.get('telegram');
    expect(record?.callbackId).toBe('opaque-2');
    expect(await createVault().decrypt(record?.encryptedCredentials ?? '')).toEqual({});
  });

  it('does not let an older provider test demote a newer healthy test generation', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: await vault.encrypt({ botToken: 'synthetic-token' }),
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    const staleTestEntered = createDeferred();
    const releaseStaleTest = createDeferred();
    const staleStops: string[] = [];
    const staleRuntime = new ChannelRuntime();
    staleRuntime.register({
      channel: 'telegram',
      test: async () => {
        staleTestEntered.resolve();
        await releaseStaleTest.promise;
        return { ok: false, issueCode: 'connection_unavailable' };
      },
      start: async () => true,
      stop: async (accountId) => staleStops.push(accountId),
      send: async () => undefined,
    });
    const healthyStarts: string[] = [];
    const healthyRuntime = new ChannelRuntime();
    healthyRuntime.register({
      channel: 'telegram',
      test: async () => ({ ok: true, accountId: 'bot-1' }),
      start: async (connection) => {
        healthyStarts.push(connection.configGeneration ?? 'missing');
        return true;
      },
      stop: async () => undefined,
      send: async () => undefined,
    });
    const staleTesting = new ChannelAdminService({
      repository,
      vault,
      runtime: staleRuntime,
      randomGeneration: () => 'generation-stale-test',
    }).test('telegram');

    await staleTestEntered.promise;
    await expect(
      new ChannelAdminService({
        repository,
        vault,
        runtime: healthyRuntime,
        randomGeneration: () => 'generation-healthy-test',
      }).test('telegram'),
    ).resolves.toMatchObject({ ok: true, channel: { state: 'connected' } });
    releaseStaleTest.resolve();

    await expect(staleTesting).resolves.toMatchObject({
      ok: false,
      channel: { state: 'connected' },
    });
    expect(repository.records.get('telegram')).toMatchObject({
      state: 'connected',
      configGeneration: 'generation-healthy-test',
      activeGeneration: 'generation-healthy-test',
      issueCode: null,
    });
    expect(healthyStarts).toEqual(['generation-healthy-test']);
    expect(staleStops).toEqual([]);
  });

  it('keeps a Telegram disconnect authoritative when another process finishes an older test', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const priorCiphertext = await vault.encrypt({ botToken: 'synthetic-prior-token' });
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: priorCiphertext,
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    const testEntered = createDeferred();
    const releaseTest = createDeferred();
    const staleEvents: string[] = [];
    const staleRuntime = new ChannelRuntime();
    staleRuntime.register({
      channel: 'telegram',
      test: async () => {
        testEntered.resolve();
        await releaseTest.promise;
        return { ok: true, accountId: 'bot-1' };
      },
      start: async () => staleEvents.push('start:prior'),
      stop: async () => staleEvents.push('stop:prior'),
      send: async () => undefined,
    });
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register(createTelegramTransport([]));
    const staleTest = new ChannelAdminService({
      repository,
      vault,
      runtime: staleRuntime,
    }).test('telegram');

    await testEntered.promise;
    await new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('telegram');
    releaseTest.resolve();

    await expect(staleTest).resolves.toMatchObject({
      ok: false,
      channel: { state: 'disconnected' },
    });
    const current = repository.records.get('telegram');
    expect(current).toMatchObject({
      state: 'disconnected',
      callbackId: 'opaque-disconnected',
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
    });
    expect(current?.encryptedCredentials).not.toBe(priorCiphertext);
    expect(await vault.decrypt(current?.encryptedCredentials ?? '')).toEqual({});
    expect(staleEvents).toEqual([]);
  });

  it('stops a stale Slack test worker after a disconnect wins during activation', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const priorCiphertext = await vault.encrypt({
      appToken: 'xapp-synthetic-prior',
      botToken: 'xoxb-synthetic-prior',
    });
    repository.records.set('slack', {
      channel: 'slack',
      state: 'connected',
      accountId: 'workspace-1',
      encryptedCredentials: priorCiphertext,
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    const startEntered = createDeferred();
    const releaseStart = createDeferred();
    const staleEvents: string[] = [];
    const staleRuntime = new ChannelRuntime();
    staleRuntime.register({
      channel: 'slack',
      test: async () => ({ ok: true, accountId: 'workspace-1' }),
      start: async () => {
        staleEvents.push('start:prior');
        startEntered.resolve();
        await releaseStart.promise;
      },
      stop: async () => staleEvents.push('stop:prior'),
      send: async () => undefined,
    });
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register({
      channel: 'slack',
      test: async () => ({ ok: true }),
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const staleTest = new ChannelAdminService({
      repository,
      vault,
      runtime: staleRuntime,
    }).test('slack');

    await startEntered.promise;
    await new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('slack');
    releaseStart.resolve();

    await expect(staleTest).resolves.toMatchObject({
      ok: false,
      channel: { state: 'disconnected' },
    });
    expect(repository.records.get('slack')).toMatchObject({
      state: 'disconnected',
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
    });
    expect(repository.records.get('slack')?.encryptedCredentials).not.toBe(priorCiphertext);
    expect(staleEvents).toEqual(['start:prior', 'stop:prior']);
  });

  it('does not let an older Telegram replacement overwrite a newer disconnect', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const priorCiphertext = await vault.encrypt({ botToken: 'synthetic-prior-token' });
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: priorCiphertext,
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    const testEntered = createDeferred();
    const releaseTest = createDeferred();
    const replacementRuntime = new ChannelRuntime();
    replacementRuntime.register({
      channel: 'telegram',
      test: async () => {
        testEntered.resolve();
        await releaseTest.promise;
        return { ok: true, accountId: 'bot-2' };
      },
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const replacing = new ChannelAdminService({
      repository,
      vault,
      runtime: replacementRuntime,
      randomGeneration: () => 'generation-replacement',
    }).connect('telegram', { botToken: 'synthetic-replacement-token' }, 'admin-1');

    await testEntered.promise;
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register(createTelegramTransport([]));
    await new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('telegram');
    releaseTest.resolve();

    await expect(replacing).rejects.toMatchObject({ issueCode: 'configuration_superseded' });
    const current = repository.records.get('telegram');
    expect(current).toMatchObject({
      state: 'disconnected',
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
    });
    expect(current?.encryptedCredentials).not.toBe(priorCiphertext);
    expect(await vault.decrypt(current?.encryptedCredentials ?? '')).toEqual({});
  });

  it('does not let a stale disconnect overwrite a newer connected generation', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: await vault.encrypt({ botToken: 'synthetic-prior-token' }),
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    const encryptEntered = createDeferred();
    const releaseEncrypt = createDeferred();
    const delayedDisconnectVault = new ChannelCredentialVault(
      async (plaintext) => {
        encryptEntered.resolve();
        await releaseEncrypt.promise;
        return `cipher:${Buffer.from(plaintext).toString('base64')}`;
      },
      async (ciphertext) =>
        Buffer.from(ciphertext.replace('cipher:', ''), 'base64').toString('utf8'),
    );
    const staleStopEvents: string[] = [];
    const staleDisconnectRuntime = new ChannelRuntime();
    staleDisconnectRuntime.register({
      ...createTelegramTransport(staleStopEvents),
      stop: async () => staleStopEvents.push('stale-disconnect-stop'),
    });
    const disconnecting = new ChannelAdminService({
      repository,
      vault: delayedDisconnectVault,
      runtime: staleDisconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('telegram');

    await encryptEntered.promise;
    const replacementRuntime = new ChannelRuntime();
    replacementRuntime.register(createTelegramTransport([]));
    await new ChannelAdminService({
      repository,
      vault,
      runtime: replacementRuntime,
      randomGeneration: () => 'generation-replacement',
    }).connect('telegram', { botToken: 'synthetic-replacement-token' }, 'admin-2');
    releaseEncrypt.resolve();

    await expect(disconnecting).resolves.toMatchObject({
      channel: 'telegram',
      state: 'connected',
    });
    const current = repository.records.get('telegram');
    expect(current).toMatchObject({
      state: 'connected',
      configGeneration: 'generation-replacement',
      activeGeneration: 'generation-replacement',
    });
    expect(await vault.decrypt(current?.encryptedCredentials ?? '')).toMatchObject({
      botToken: 'synthetic-replacement-token',
    });
    expect(staleStopEvents).toEqual([]);
  });

  it('does not let a late worker-stop error overwrite a newer connection', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: await vault.encrypt({ botToken: 'synthetic-prior-token' }),
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    const stopEntered = createDeferred();
    const releaseStop = createDeferred();
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register({
      channel: 'telegram',
      test: async () => ({ ok: true }),
      start: async () => undefined,
      stop: async () => {
        stopEntered.resolve();
        await releaseStop.promise;
        throw new Error('synthetic worker stop failure');
      },
      send: async () => undefined,
    });
    const disconnecting = new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('telegram');

    await stopEntered.promise;
    const replacementRuntime = new ChannelRuntime();
    replacementRuntime.register(createTelegramTransport([]));
    await new ChannelAdminService({
      repository,
      vault,
      runtime: replacementRuntime,
      randomGeneration: () => 'generation-replacement',
    }).connect('telegram', { botToken: 'synthetic-replacement-token' }, 'admin-2');
    const replacementCiphertext = repository.records.get('telegram')?.encryptedCredentials;
    releaseStop.resolve();

    await expect(disconnecting).resolves.toMatchObject({
      channel: 'telegram',
      state: 'connected',
    });
    expect(repository.records.get('telegram')).toMatchObject({
      state: 'connected',
      encryptedCredentials: replacementCiphertext,
      configGeneration: 'generation-replacement',
      activeGeneration: 'generation-replacement',
      issueCode: null,
    });
  });

  it('restores encrypted connected records after restart without returning their secrets', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: await vault.encrypt({ botToken: 'synthetic-token' }),
      callbackId: 'opaque-1',
    });
    const runtime = new ChannelRuntime();
    const events: string[] = [];
    runtime.register(createTelegramTransport(events));
    const service = new ChannelAdminService({
      repository,
      vault,
      runtime,
      randomId: () => 'opaque-2',
    });

    await service.restore();

    expect(events).toEqual(['start:bot-1']);
  });

  it('cannot resurrect disconnected credentials when restore loses a cross-process race', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    const priorCipher = await vault.encrypt({ botToken: 'synthetic-prior-token' });
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: priorCipher,
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    let releaseRestore;
    const restoreBlocked = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreStarted;
    const restoreEntered = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    const restoreEvents: string[] = [];
    const restoreRuntime = new ChannelRuntime();
    restoreRuntime.register({
      channel: 'telegram',
      test: async () => ({ ok: true }),
      start: async () => {
        restoreEvents.push('start:prior');
        restoreStarted();
        await restoreBlocked;
        throw new Error('synthetic worker start failure');
      },
      stop: async () => {
        restoreEvents.push('stop:prior');
      },
      send: async () => undefined,
    });
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register({
      channel: 'telegram',
      test: async () => ({ ok: true }),
      start: async () => true,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const restoring = new ChannelAdminService({
      repository,
      vault,
      runtime: restoreRuntime,
    }).restore();
    await restoreEntered;
    const disconnecting = new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    });

    await disconnecting.disconnect('telegram');
    releaseRestore();
    await restoring;

    const current = repository.records.get('telegram');
    expect(current).toMatchObject({
      state: 'disconnected',
      callbackId: 'opaque-disconnected',
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
    });
    expect(current?.encryptedCredentials).not.toBe(priorCipher);
    expect(await vault.decrypt(current?.encryptedCredentials ?? '')).toEqual({});
    expect(restoreEvents).toEqual(['start:prior']);
  });

  it('stops a stale worker when restore activation loses its generation CAS', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = createVault();
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: await vault.encrypt({ botToken: 'synthetic-prior-token' }),
      callbackId: 'opaque-prior',
      configGeneration: 'generation-prior',
      activeGeneration: 'generation-prior',
    });
    let releaseRestore;
    const restoreBlocked = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreStarted;
    const restoreEntered = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    const events: string[] = [];
    const restoreRuntime = new ChannelRuntime();
    restoreRuntime.register({
      channel: 'telegram',
      test: async () => ({ ok: true }),
      start: async () => {
        events.push('start:prior');
        restoreStarted();
        await restoreBlocked;
        return true;
      },
      stop: async () => {
        events.push('stop:prior');
      },
      send: async () => undefined,
    });
    const disconnectRuntime = new ChannelRuntime();
    disconnectRuntime.register({
      channel: 'telegram',
      test: async () => ({ ok: true }),
      start: async () => true,
      stop: async () => undefined,
      send: async () => undefined,
    });
    const restoring = new ChannelAdminService({
      repository,
      vault,
      runtime: restoreRuntime,
    }).restore();
    await restoreEntered;
    await new ChannelAdminService({
      repository,
      vault,
      runtime: disconnectRuntime,
      randomId: () => 'opaque-disconnected',
      randomGeneration: () => 'generation-disconnected',
    }).disconnect('telegram');
    releaseRestore();
    await restoring;

    expect(repository.records.get('telegram')).toMatchObject({
      state: 'disconnected',
      configGeneration: 'generation-disconnected',
      activeGeneration: null,
    });
    expect(events).toEqual(['start:prior', 'stop:prior']);
  });

  it('fails closed instead of trusting unauthenticated legacy credential ciphertext', async () => {
    const repository = new MemoryConnectionRepository();
    const vault = new ChannelCredentialVault(
      async (plaintext) => `v4:${Buffer.from(plaintext).toString('base64')}`,
      async (ciphertext) => {
        if (!ciphertext.startsWith('v4:')) {
          throw new Error('unauthenticated legacy envelope');
        }
        return Buffer.from(ciphertext.slice(3), 'base64').toString('utf8');
      },
    );
    repository.records.set('telegram', {
      channel: 'telegram',
      state: 'connected',
      accountId: 'bot-1',
      encryptedCredentials: 'legacy:possibly-malleated-ciphertext',
      pendingEncryptedCredentials: 'legacy:possibly-malleated-pending-ciphertext',
      callbackId: 'opaque-1',
      configGeneration: 'generation-1',
      activeGeneration: 'generation-1',
    });
    const starts: string[] = [];
    const runtime = new ChannelRuntime();
    runtime.register({
      channel: 'telegram',
      test: async () => ({ ok: true }),
      start: async (connection) => {
        starts.push(connection.credentials.botToken);
        return true;
      },
      stop: async () => undefined,
      send: async () => undefined,
    });
    const service = new ChannelAdminService({ repository, vault, runtime });

    await service.restore();

    expect(repository.records.get('telegram')).toMatchObject({
      state: 'reauth_required',
      issueCode: 'credentials_unavailable',
      encryptedCredentials: 'legacy:possibly-malleated-ciphertext',
      pendingEncryptedCredentials: 'legacy:possibly-malleated-pending-ciphertext',
    });
    expect(starts).toEqual([]);
  });
});
