/* === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Adapt the typed channel service to LibreChat's Mongo models and shared credential crypto.
 * === VIVENTIUM END === */

const {
  ChannelAdminService,
  ChannelCredentialVault,
  ChannelRuntime,
  ChannelGatewayClient,
  TelegramBotApiTransport,
  SlackSocketModeTransport,
  WhatsAppCloudTransport,
  ChannelPairingService,
  resolveLoopbackGatewayUrl,
  buildChannelDedupeKey,
  hashPairingCode,
} = require('@librechat/api');
const {
  encryptChannelCredentialsV4,
  decryptChannelCredentialsV4,
  logger,
} = require('@librechat/data-schemas');
const {
  ChannelConnection,
  ChannelPairingCode,
  ChannelPairingAttempt,
  GatewayUserMapping,
  ChannelThread,
  GatewayLinkToken,
  ViventiumGatewayIngressEvent,
  ChannelWorkerLease,
  ChannelDelivery,
  ChannelIngressQuota,
} = require('~/db/models');
const {
  createChannelWorkerReconciler,
  createRetryableReadiness,
  ensureChannelPersistenceIndexes,
} = require('./channelPersistence');
const { ChannelDeliveryQueue } = require('./channelDeliveryQueue');
const { ChannelIngressRateLimiter } = require('./channelIngressRateLimiter');
const { reservePairingAttempt } = require('./channelPairingAttemptLimiter');
const { createChannelWorkerLeaseTransport } = require('./channelWorkerLease');
const { updateOwnedChannelHealth } = require('./channelProviderHealth');
const { resolveChannelControlReply } = require('./channelIngressControl');
const {
  assertNativeApiSocketAvailable,
  resolveNativeChannelGatewayTransport,
} = require('./nativeApiListen');
const crypto = require('crypto');

const runtime = new ChannelRuntime();
let service;
let productionTransportsRegistered = false;
let whatsappTransport;
let gatewayClient;
let pairingService;
const workerOwnerId = crypto.randomUUID();
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
const ingressRateLimiter = new ChannelIngressRateLimiter({
  model: ChannelIngressQuota,
  windowMs: boundedInteger(
    process.env.VIVENTIUM_CHANNEL_RATE_WINDOW_MS,
    300_000,
    10_000,
    3_600_000,
  ),
  limits: {
    unpaired: boundedInteger(process.env.VIVENTIUM_CHANNEL_UNPAIRED_LIMIT, 5, 1, 100),
    paired: boundedInteger(process.env.VIVENTIUM_CHANNEL_PAIRED_LIMIT, 20, 1, 1000),
  },
  accountLimits: {
    unpaired: boundedInteger(process.env.VIVENTIUM_CHANNEL_UNPAIRED_ACCOUNT_LIMIT, 50, 1, 1000),
    paired: boundedInteger(process.env.VIVENTIUM_CHANNEL_PAIRED_ACCOUNT_LIMIT, 200, 1, 10_000),
  },
  resolveTier: async (envelope) =>
    envelope.authorizationSnapshot?.kind === 'paired' ? 'paired' : 'unpaired',
});
const durableQueue = new ChannelDeliveryQueue({
  model: ChannelDelivery,
  dedupe: buildChannelDedupeKey,
  logger,
  getConnectionState: async (channel, accountId) => {
    const record = await ChannelConnection.findOne({ channel, accountId }).select('state').lean();
    return record?.state || 'disconnected';
  },
  admit: async (envelope) => {
    await ensureChannelSubsystemReady();
    if (extractPairingCode(envelope.text).matched) {
      const pairing = extractPairingCode(envelope.text);
      return {
        ...envelope,
        text: '/pair [REDACTED]',
        authorizationSnapshot: {
          kind: 'pairing',
          pairingTokenHash: pairing.code ? hashPairingCode(pairing.code) : '',
        },
      };
    }
    const mapping = await GatewayUserMapping.findOne({
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
    })
      .select('libreChatUserId linkedAt')
      .lean();
    if (!mapping?.libreChatUserId) {
      return { ...envelope, authorizationSnapshot: { kind: 'unpaired' } };
    }
    return {
      ...envelope,
      authorizationSnapshot: {
        kind: 'paired',
        libreChatUserId: String(mapping.libreChatUserId),
        bindingVersion:
          mapping.linkedAt instanceof Date
            ? mapping.linkedAt.toISOString()
            : String(mapping.linkedAt || ''),
      },
    };
  },
  rateLimiter: ingressRateLimiter,
  validateAuthorization: async (envelope) => {
    const snapshot = envelope.authorizationSnapshot;
    if (snapshot?.kind !== 'paired') {
      return true;
    }
    const mapping = await GatewayUserMapping.findOne({
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
    })
      .select('libreChatUserId linkedAt')
      .lean();
    const bindingVersion =
      mapping?.linkedAt instanceof Date
        ? mapping.linkedAt.toISOString()
        : String(mapping?.linkedAt || '');
    return Boolean(
      mapping?.libreChatUserId &&
      String(mapping.libreChatUserId) === snapshot.libreChatUserId &&
      bindingVersion === (snapshot.bindingVersion || ''),
    );
  },
});

const ensureChannelSubsystemReady = createRetryableReadiness(() =>
  ensureChannelPersistenceIndexes({
    ChannelConnection,
    ChannelThread,
    ChannelPairingCode,
    ChannelPairingAttempt,
    GatewayUserMapping,
    GatewayLinkToken,
    ViventiumGatewayIngressEvent,
    ChannelWorkerLease,
    ChannelDelivery,
    ChannelIngressQuota,
  }),
);

function withWorkerLease(transport) {
  return createChannelWorkerLeaseTransport({
    transport,
    leaseModel: ChannelWorkerLease,
    connectionModel: ChannelConnection,
    logger,
    ownerId: workerOwnerId,
  });
}

function toRecord(value) {
  if (!value) {
    return null;
  }
  return {
    channel: value.channel,
    state: value.state,
    accountId: value.accountId || 'default',
    accountLabel: value.accountLabel ?? null,
    displayName: value.displayName ?? null,
    encryptedCredentials: value.encryptedCredentials || '',
    callbackId: value.callbackId,
    publicBaseUrl: value.publicBaseUrl ?? null,
    issueCode: value.issueCode ?? null,
    lastVerifiedAt: value.lastVerifiedAt ?? null,
    webhookVerifiedAt: value.webhookVerifiedAt ?? null,
    webhookSignedVerifiedAt: value.webhookSignedVerifiedAt ?? null,
    configGeneration: value.configGeneration ?? null,
    activeGeneration: value.activeGeneration ?? null,
    pendingEncryptedCredentials: value.pendingEncryptedCredentials ?? null,
    pendingCallbackId: value.pendingCallbackId ?? null,
    pendingAccountId: value.pendingAccountId ?? null,
    pendingAccountLabel: value.pendingAccountLabel ?? null,
    pendingDisplayName: value.pendingDisplayName ?? null,
    pendingConfigGeneration: value.pendingConfigGeneration ?? null,
    pendingWebhookVerifiedAt: value.pendingWebhookVerifiedAt ?? null,
    createdBy: value.createdBy ? String(value.createdBy) : null,
  };
}

const repository = {
  async list() {
    const values = await ChannelConnection.find({})
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return values.map(toRecord).filter(Boolean);
  },

  async findByChannel(channel) {
    const value = await ChannelConnection.findOne({ channel })
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return toRecord(value);
  },

  async findByCallbackId(callbackId) {
    const value = await ChannelConnection.findOne({
      $or: [{ callbackId }, { pendingCallbackId: callbackId }],
    })
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return toRecord(value);
  },

  async saveIfGeneration(expectedGeneration, record, expectedPendingGeneration) {
    try {
      const value = await ChannelConnection.findOneAndUpdate(
        {
          channel: record.channel,
          configGeneration: expectedGeneration,
          ...(expectedPendingGeneration !== undefined
            ? { pendingConfigGeneration: expectedPendingGeneration }
            : {}),
        },
        { $set: record },
        {
          new: true,
          upsert: expectedGeneration === null,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      )
        .select('+encryptedCredentials +pendingEncryptedCredentials')
        .lean();
      return toRecord(value);
    } catch (error) {
      if (Number(error?.code) === 11000) {
        return null;
      }
      throw error;
    }
  },

  async stageActivation(expectedGeneration, record, expectedPendingGeneration) {
    const value = await ChannelConnection.findOneAndUpdate(
      {
        channel: record.channel,
        configGeneration: expectedGeneration,
        ...(expectedPendingGeneration !== undefined
          ? { pendingConfigGeneration: expectedPendingGeneration }
          : {}),
        $or: [{ state: { $ne: 'connected' } }, { activeGeneration: { $ne: expectedGeneration } }],
      },
      { $set: record },
      { new: true, runValidators: true },
    )
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return toRecord(value);
  },

  async stageWhatsAppCandidate(expectedActiveGeneration, expectedPendingGeneration, record) {
    const value = await ChannelConnection.findOneAndUpdate(
      {
        channel: 'whatsapp',
        configGeneration: expectedActiveGeneration,
        pendingConfigGeneration: expectedPendingGeneration,
        state: { $ne: 'disconnected' },
      },
      { $set: record },
      { new: true, runValidators: true },
    )
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return toRecord(value);
  },

  async saveWhatsAppCandidate(expectedActiveGeneration, expectedPendingGeneration, record) {
    const value = await ChannelConnection.findOneAndUpdate(
      {
        channel: 'whatsapp',
        configGeneration: expectedActiveGeneration,
        pendingConfigGeneration: expectedPendingGeneration,
      },
      { $set: record },
      { new: true, runValidators: true },
    )
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return toRecord(value);
  },

  async promoteWhatsAppCandidate(expectedActiveGeneration, expectedPendingGeneration, record) {
    const value = await ChannelConnection.findOneAndUpdate(
      {
        channel: 'whatsapp',
        configGeneration: expectedActiveGeneration,
        pendingConfigGeneration: expectedPendingGeneration,
      },
      { $set: record },
      { new: true, runValidators: true },
    )
      .select('+encryptedCredentials +pendingEncryptedCredentials')
      .lean();
    return toRecord(value);
  },
};

const pairingRepository = {
  async invalidate(channel, accountId, libreChatUserId, now) {
    await ChannelPairingCode.updateMany(
      { channel, accountId, libreChatUserId, consumedAt: null },
      { $set: { consumedAt: now } },
    );
  },

  async create(record) {
    await ChannelPairingCode.create(record);
  },

  async consumeAndBind(tokenHash, scope, now) {
    const consumed = await ChannelPairingCode.findOneAndUpdate(
      {
        tokenHash,
        channel: scope.channel,
        accountId: scope.accountId,
        consumedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
      { new: true },
    ).lean();
    if (!consumed) {
      const prior = await ChannelPairingCode.findOne({
        tokenHash,
        channel: scope.channel,
        accountId: scope.accountId,
        consumedAt: { $ne: null },
      }).lean();
      if (!prior) {
        return null;
      }
      const mapping = await GatewayUserMapping.findOne({
        channel: scope.channel,
        accountId: scope.accountId,
        externalUserId: scope.externalUserId,
      }).lean();
      return mapping?.libreChatUserId &&
        String(mapping.libreChatUserId) === String(prior.libreChatUserId)
        ? prior
        : null;
    }
    try {
      await GatewayUserMapping.findOneAndUpdate(
        {
          channel: scope.channel,
          accountId: scope.accountId,
          externalUserId: scope.externalUserId,
        },
        {
          $set: {
            externalUsername: scope.externalUsername,
            libreChatUserId: consumed.libreChatUserId,
            linkedAt: now,
            lastSeenAt: now,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
      return consumed;
    } catch (error) {
      await ChannelPairingCode.updateOne(
        { _id: consumed._id, consumedAt: now },
        { $set: { consumedAt: null } },
      ).catch(() => undefined);
      throw error;
    }
  },

  async reserveAttempt(scopeKey, maximumAttempts, windowExpiresAt) {
    return await reservePairingAttempt({
      model: ChannelPairingAttempt,
      scopeKey,
      maximumAttempts,
      now: new Date(),
      windowExpiresAt,
    });
  },
};

function getPairingService() {
  if (!pairingService) {
    pairingService = new ChannelPairingService({ repository: pairingRepository });
  }
  return pairingService;
}

function getTrustedPublicApiUrl() {
  return (process.env.VIVENTIUM_PUBLIC_SERVER_URL || process.env.DOMAIN_SERVER || '').trim();
}

function getLocalGatewayUrl() {
  const port = Number.parseInt(process.env.PORT || '', 10);
  return resolveLoopbackGatewayUrl(
    (process.env.VIVENTIUM_CHANNEL_GATEWAY_URL || '').trim(),
    Number.isFinite(port) ? port : 3080,
  );
}

function getLocalGatewayTransport() {
  const socketPath = process.env.VIVENTIUM_NATIVE_API_SOCKET;
  return resolveNativeChannelGatewayTransport({
    socketPath,
    loopbackUrl: socketPath == null || socketPath === '' ? getLocalGatewayUrl() : '',
  });
}

function ensureLocalGatewayTransportReady() {
  const nativeApiSocket = process.env.VIVENTIUM_NATIVE_API_SOCKET;
  if (nativeApiSocket != null && nativeApiSocket !== '') {
    assertNativeApiSocketAvailable(nativeApiSocket);
  }
}

const conversationStore = {
  async load(envelope) {
    const snapshot = envelope.authorizationSnapshot;
    if (snapshot?.kind !== 'paired' || !snapshot.libreChatUserId) {
      return undefined;
    }
    const mapping = await GatewayUserMapping.findOne({
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
    }).lean();
    const bindingVersion =
      mapping?.linkedAt instanceof Date
        ? mapping.linkedAt.toISOString()
        : String(mapping?.linkedAt || '');
    if (
      !mapping?.libreChatUserId ||
      String(mapping.libreChatUserId) !== snapshot.libreChatUserId ||
      bindingVersion !== (snapshot.bindingVersion || '')
    ) {
      return undefined;
    }
    const thread = await ChannelThread.findOne({
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalConversationId: envelope.externalConversationId,
      externalThreadId: envelope.externalThreadId,
      libreChatUserId: snapshot.libreChatUserId,
    }).lean();
    return thread?.conversationId || undefined;
  },

  async save(envelope, conversationId) {
    const snapshot = envelope.authorizationSnapshot;
    if (snapshot?.kind !== 'paired' || !snapshot.libreChatUserId) {
      return;
    }
    const mapping = await GatewayUserMapping.findOne({
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
    }).lean();
    const bindingVersion =
      mapping?.linkedAt instanceof Date
        ? mapping.linkedAt.toISOString()
        : String(mapping?.linkedAt || '');
    if (
      !mapping?.libreChatUserId ||
      String(mapping.libreChatUserId) !== snapshot.libreChatUserId ||
      bindingVersion !== (snapshot.bindingVersion || '')
    ) {
      return;
    }
    await ChannelThread.findOneAndUpdate(
      {
        channel: envelope.channel,
        accountId: envelope.accountId,
        externalConversationId: envelope.externalConversationId,
        externalThreadId: envelope.externalThreadId,
        libreChatUserId: snapshot.libreChatUserId,
      },
      {
        $set: { conversationId, lastSeenAt: new Date() },
      },
      { upsert: true, new: true, runValidators: true },
    );
  },
};

function registerProductionTransports() {
  if (productionTransportsRegistered) {
    return;
  }
  const { getGatewaySecret } = require('./gateway/security');
  const gatewaySecret = getGatewaySecret();
  if (!gatewaySecret) {
    logger.warn('[VIVENTIUM][channels] Production transports disabled: gateway secret is missing');
    return;
  }
  gatewayClient = new ChannelGatewayClient({
    ...getLocalGatewayTransport(),
    secret: gatewaySecret,
    conversationStore,
  });
  const onIngress = handleProductionIngress;
  const onTransportError = (error) =>
    logger.warn('[VIVENTIUM][channels] Provider transport error', {
      error: error?.name || 'Error',
    });
  const onProviderHealth = async (channel, accountId, issueCode, sourceGeneration) => {
    await updateOwnedChannelHealth({
      channel,
      accountId,
      issueCode,
      ownerId: workerOwnerId,
      sourceGeneration,
      leaseModel: ChannelWorkerLease,
      connectionModel: ChannelConnection,
      stopStale: (staleGeneration) =>
        runtime.stop(channel, accountId, staleGeneration).catch(() => undefined),
    });
  };
  const operatorManaged = ['true', '1'].includes(
    String(process.env.START_TELEGRAM || '').toLowerCase(),
  );
  if (operatorManaged) {
    runtime.register({
      channel: 'telegram',
      async start() {
        throw new Error('Telegram is managed by the packaged operator');
      },
      async stop() {},
      async test() {
        return { ok: false, issueCode: 'operator_managed' };
      },
      async send() {
        throw new Error('Telegram is managed by the packaged operator');
      },
    });
  } else {
    runtime.register(
      withWorkerLease(
        new TelegramBotApiTransport({
          onIngress,
          durableQueue,
          onError: onTransportError,
          onHealth: (accountId, issueCode, sourceGeneration) =>
            onProviderHealth('telegram', accountId, issueCode, sourceGeneration),
        }),
      ),
    );
  }

  let socketModeClientFactory;
  let webClientFactory;
  try {
    const { SocketModeClient } = require('@slack/socket-mode');
    const { WebClient } = require('@slack/web-api');
    socketModeClientFactory = (appToken) => new SocketModeClient({ appToken });
    webClientFactory = (botToken) => new WebClient(botToken);
  } catch (_error) {
    logger.warn('[VIVENTIUM][channels] Official Slack SDK dependencies are unavailable');
  }
  if (socketModeClientFactory && webClientFactory) {
    runtime.register(
      withWorkerLease(
        new SlackSocketModeTransport({
          onIngress,
          socketModeClientFactory,
          webClientFactory,
          onError: onTransportError,
          durableQueue,
          onHealth: (accountId, issueCode, sourceGeneration) =>
            onProviderHealth('slack', accountId, issueCode, sourceGeneration),
        }),
      ),
    );
  }

  whatsappTransport = new WhatsAppCloudTransport({
    onIngress,
    graphVersion: process.env.VIVENTIUM_WHATSAPP_GRAPH_VERSION,
    durableQueue,
    onHealth: (accountId, issueCode, sourceGeneration) =>
      onProviderHealth('whatsapp', accountId, issueCode, sourceGeneration),
  });
  runtime.register(withWorkerLease(whatsappTransport));
  productionTransportsRegistered = true;
}

function extractPairingCode(text) {
  if (typeof text !== 'string') {
    return { matched: false, code: '' };
  }
  const parts = text.trim().split(/\s+/);
  if (String(parts[0] || '').toLowerCase() !== '/pair') {
    return { matched: false, code: '' };
  }
  return { matched: true, code: parts.length === 2 ? parts[1] : '' };
}

async function handleProductionIngress(envelope) {
  await ensureChannelSubsystemReady();
  const pairingCommand = extractPairingCode(envelope.text);
  if (pairingCommand.matched) {
    if (envelope.pairingContext !== 'private') {
      return { text: 'Pairing is only available in a private direct message.' };
    }
    const pairingTokenHash =
      envelope.authorizationSnapshot?.kind === 'pairing'
        ? envelope.authorizationSnapshot.pairingTokenHash
        : '';
    if (!pairingCommand.code && !pairingTokenHash) {
      return { text: 'That pairing code is invalid or expired. Create a new code in Viventium.' };
    }
    const pairingScope = {
      channel: envelope.channel,
      accountId: envelope.accountId,
      externalUserId: envelope.externalUserId,
      externalUsername: envelope.externalUsername,
    };
    const result = pairingTokenHash
      ? await getPairingService().consumeHash(pairingScope, pairingTokenHash)
      : await getPairingService().consume(pairingScope, pairingCommand.code);
    if (result.ok) {
      return { text: 'Connected. You can now message Viventium normally.' };
    }
    if (result.error === 'rate_limited') {
      return { text: 'Too many pairing attempts. Wait a few minutes and try a new code.' };
    }
    return { text: 'That pairing code is invalid or expired. Create a new code in Viventium.' };
  }
  const snapshot = envelope.authorizationSnapshot;
  if (snapshot?.kind !== 'paired' || !snapshot.libreChatUserId) {
    return {
      text: 'This channel is not paired yet. In Viventium, open Settings > Channels, create your pairing code, then send it here privately as /pair CODE.',
    };
  }
  const mapping = await GatewayUserMapping.findOne({
    channel: envelope.channel,
    accountId: envelope.accountId,
    externalUserId: envelope.externalUserId,
  })
    .select('libreChatUserId linkedAt')
    .lean();
  const bindingVersion =
    mapping?.linkedAt instanceof Date
      ? mapping.linkedAt.toISOString()
      : String(mapping?.linkedAt || '');
  if (
    !mapping?.libreChatUserId ||
    String(mapping.libreChatUserId) !== snapshot.libreChatUserId ||
    bindingVersion !== (snapshot.bindingVersion || '')
  ) {
    return { text: 'Your channel account link changed. Please send that message again.' };
  }
  const controlReply = resolveChannelControlReply(envelope);
  if (controlReply) {
    return { text: controlReply };
  }
  if (!gatewayClient) {
    throw new Error('Channel gateway is unavailable');
  }
  return await gatewayClient.handle(envelope);
}

async function createChannelPairingCode(channel, adminUserId) {
  await ensureChannelSubsystemReady();
  const connection = await repository.findByChannel(channel);
  if (!connection || connection.state !== 'connected') {
    const error = new Error('Channel must be configured before creating a pairing code');
    error.status = 409;
    throw error;
  }
  return await getPairingService().create(channel, connection.accountId, adminUserId);
}

function getChannelAdminService() {
  registerProductionTransports();
  if (!service) {
    service = new ChannelAdminService({
      repository,
      vault: new ChannelCredentialVault(encryptChannelCredentialsV4, decryptChannelCredentialsV4),
      runtime,
      trustedPublicApiUrl: getTrustedPublicApiUrl(),
    });
  }
  return service;
}

async function handleWhatsAppWebhook(payload, callbackId) {
  await ensureChannelSubsystemReady();
  const adminService = getChannelAdminService();
  const connection = await adminService.getWhatsAppWebhookConnection(callbackId);
  if (!connection || !whatsappTransport) {
    throw new Error('WhatsApp transport is unavailable');
  }
  const handled = await whatsappTransport.processWebhook(connection, payload);
  if (handled > 0) {
    void adminService.markWhatsAppSignedCallbackVerified(callbackId).catch((error) => {
      logger.warn('[VIVENTIUM][channels] WhatsApp signed callback activation failed', {
        error: error?.name || 'Error',
      });
    });
  }
  return handled;
}

const restoreChannelWorkers = createChannelWorkerReconciler({
  logger,
  reconcile: async () => {
    await ensureChannelSubsystemReady();
    ensureLocalGatewayTransportReady();
    await getChannelAdminService().restore();
  },
});

module.exports = {
  getChannelAdminService,
  restoreChannelWorkers,
  channelRuntime: runtime,
  channelConnectionRepository: repository,
  handleWhatsAppWebhook,
  createChannelPairingCode,
  handleProductionIngress,
  ensureChannelSubsystemReady,
};
