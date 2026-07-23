/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels cross-process lifecycle fencing.
 * Purpose: Prove the production Mongo repository makes generation and pending-callback CAS atomic.
 * === VIVENTIUM END ===
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ChannelConnection } = require('~/db/models');
const { channelConnectionRepository: repository } = require('../channelAdminService');

function record(channel, generation, callbackId, encryptedCredentials) {
  return {
    channel,
    state: 'connected',
    accountId: `${channel}-account`,
    encryptedCredentials,
    callbackId,
    configGeneration: generation,
    activeGeneration: generation,
    pendingConfigGeneration: null,
    pendingCallbackId: null,
  };
}

describe('channelConnectionRepository lifecycle CAS', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      instance: { dbName: 'viventium_channel_cas' },
    });
    await mongoose.connect(mongoServer.getUri());
    await ChannelConnection.syncIndexes();
  }, 120_000);

  afterEach(async () => {
    await ChannelConnection.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('allows exactly one initial creator and rejects the stale concurrent insert', async () => {
    const attempts = await Promise.all([
      repository.saveIfGeneration(
        null,
        record('telegram', 'generation-a', 'callback-a', 'ciphertext-a'),
      ),
      repository.saveIfGeneration(
        null,
        record('telegram', 'generation-b', 'callback-b', 'ciphertext-b'),
      ),
    ]);

    expect(attempts.filter(Boolean)).toHaveLength(1);
    await expect(ChannelConnection.countDocuments({ channel: 'telegram' })).resolves.toBe(1);
    const stored = await repository.findByChannel('telegram');
    expect(['generation-a', 'generation-b']).toContain(stored?.configGeneration);
  });

  it('does not let a stale generation overwrite a replacement', async () => {
    await repository.saveIfGeneration(
      null,
      record('slack', 'generation-old', 'callback-old', 'ciphertext-old'),
    );
    const replacement = record('slack', 'generation-new', 'callback-new', 'ciphertext-new');
    const stale = {
      ...record('slack', 'generation-old', 'callback-old', 'ciphertext-old'),
      state: 'degraded',
      issueCode: 'connection_unavailable',
    };

    await expect(repository.saveIfGeneration('generation-old', replacement)).resolves.toMatchObject(
      {
        configGeneration: 'generation-new',
      },
    );
    await expect(repository.saveIfGeneration('generation-old', stale)).resolves.toBeNull();
    await expect(repository.findByChannel('slack')).resolves.toMatchObject({
      state: 'connected',
      encryptedCredentials: 'ciphertext-new',
      callbackId: 'callback-new',
      configGeneration: 'generation-new',
    });
  });

  it('does not let an active WhatsApp write erase a newer pending callback generation', async () => {
    const active = record(
      'whatsapp',
      'generation-active',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'ciphertext-active',
    );
    await repository.saveIfGeneration(null, active, null);
    const pending = {
      ...active,
      pendingEncryptedCredentials: 'ciphertext-pending-new',
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pendingConfigGeneration: 'generation-pending-new',
    };
    await repository.stageWhatsAppCandidate('generation-active', null, pending);

    await expect(
      repository.saveIfGeneration('generation-active', active, null),
    ).resolves.toBeNull();
    await expect(repository.findByChannel('whatsapp')).resolves.toMatchObject({
      encryptedCredentials: 'ciphertext-active',
      configGeneration: 'generation-active',
      pendingEncryptedCredentials: 'ciphertext-pending-new',
      pendingCallbackId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pendingConfigGeneration: 'generation-pending-new',
    });
  });

  it('persists the admin-supplied public HTTPS origin used for a WhatsApp callback', async () => {
    const candidate = {
      ...record(
        'whatsapp',
        'generation-public-origin',
        'cccccccccccccccccccccccccccccccc',
        'ciphertext-public-origin',
      ),
      state: 'needs_vendor_step',
      publicBaseUrl: 'https://api.example.test',
    };

    await expect(repository.saveIfGeneration(null, candidate, null)).resolves.toMatchObject({
      publicBaseUrl: 'https://api.example.test',
    });
    await expect(repository.findByChannel('whatsapp')).resolves.toMatchObject({
      publicBaseUrl: 'https://api.example.test',
    });
  });
});
