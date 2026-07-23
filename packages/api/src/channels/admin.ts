/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Own secret-safe connection lifecycle and restart restoration independently of Express.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import { normalizeChannelConnectInput, resolveTrustedCallbackUrl } from './contract';
import { ChannelCredentialVault } from './credentials';
import { ChannelRuntime } from './runtime';
import { CHANNEL_IDS } from './types';
import type { ChannelConnectionState, ChannelId, ChannelSummary } from './types';

export type ChannelConnectionRecord = {
  channel: ChannelId;
  state: ChannelConnectionState;
  accountId: string;
  accountLabel?: string | null;
  displayName?: string | null;
  encryptedCredentials: string;
  callbackId: string;
  publicBaseUrl?: string | null;
  issueCode?: string | null;
  lastVerifiedAt?: Date | null;
  webhookVerifiedAt?: Date | null;
  webhookSignedVerifiedAt?: Date | null;
  configGeneration?: string | null;
  activeGeneration?: string | null;
  pendingEncryptedCredentials?: string | null;
  pendingCallbackId?: string | null;
  pendingAccountId?: string | null;
  pendingAccountLabel?: string | null;
  pendingDisplayName?: string | null;
  pendingConfigGeneration?: string | null;
  pendingWebhookVerifiedAt?: Date | null;
  createdBy?: string | null;
};

export interface ChannelConnectionRepository {
  list(): Promise<ChannelConnectionRecord[]>;
  findByChannel(channel: ChannelId): Promise<ChannelConnectionRecord | null>;
  findByCallbackId(callbackId: string): Promise<ChannelConnectionRecord | null>;
  saveIfGeneration(
    expectedGeneration: string | null,
    record: ChannelConnectionRecord,
    expectedPendingGeneration?: string | null,
  ): Promise<ChannelConnectionRecord | null>;
  stageActivation(
    expectedGeneration: string,
    record: ChannelConnectionRecord,
    expectedPendingGeneration?: string | null,
  ): Promise<ChannelConnectionRecord | null>;
  stageWhatsAppCandidate(
    expectedActiveGeneration: string | null,
    expectedPendingGeneration: string | null,
    record: ChannelConnectionRecord,
  ): Promise<ChannelConnectionRecord | null>;
  saveWhatsAppCandidate(
    expectedActiveGeneration: string | null,
    expectedPendingGeneration: string,
    record: ChannelConnectionRecord,
  ): Promise<ChannelConnectionRecord | null>;
  promoteWhatsAppCandidate(
    expectedActiveGeneration: string | null,
    expectedPendingGeneration: string,
    record: ChannelConnectionRecord,
  ): Promise<ChannelConnectionRecord | null>;
}

type ChannelAdminServiceOptions = {
  repository: ChannelConnectionRepository;
  vault: ChannelCredentialVault;
  runtime: ChannelRuntime;
  trustedPublicApiUrl?: string;
  randomId?: () => string;
  randomGeneration?: () => string;
};

export type ChannelTestResponse = {
  ok: boolean;
  channel: ChannelSummary;
  message: string;
};

export type WhatsAppWebhookSecrets = {
  appSecret: string;
  verifyToken: string;
};

export class ChannelRepairRejectedError extends Error {
  readonly status = 409;
  readonly issueCode: string;

  constructor(issueCode: string) {
    super('New channel settings could not be verified; the previous connection remains active.');
    this.name = 'ChannelRepairRejectedError';
    this.issueCode = issueCode;
  }
}

function issueCodeFromError(error: unknown, fallback: string): string {
  const issueCode = (error as { issueCode?: unknown })?.issueCode;
  return typeof issueCode === 'string' && issueCode ? issueCode : fallback;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export class ChannelAdminService {
  private readonly repository: ChannelConnectionRepository;
  private readonly vault: ChannelCredentialVault;
  private readonly runtime: ChannelRuntime;
  private readonly trustedPublicApiUrl?: string;
  private readonly randomId: () => string;
  private readonly randomGeneration: () => string;
  private readonly lifecycleTails = new Map<ChannelId, Promise<unknown>>();

  constructor(options: ChannelAdminServiceOptions) {
    this.repository = options.repository;
    this.vault = options.vault;
    this.runtime = options.runtime;
    this.trustedPublicApiUrl = normalizeOrigin(options.trustedPublicApiUrl);
    this.randomId = options.randomId ?? (() => crypto.randomBytes(32).toString('hex'));
    this.randomGeneration =
      options.randomGeneration ?? (() => crypto.randomBytes(24).toString('hex'));
  }

  private toSummary(record: ChannelConnectionRecord): ChannelSummary {
    const summary: ChannelSummary = {
      channel: record.channel,
      state: record.state,
    };
    if (record.displayName) {
      summary.displayName = record.displayName;
    }
    if (record.issueCode) {
      summary.issueCode = record.issueCode;
    }
    if (record.channel === 'whatsapp') {
      const callbackUrl = resolveTrustedCallbackUrl(
        record.publicBaseUrl || this.trustedPublicApiUrl,
        record.callbackId,
      );
      if (callbackUrl) {
        summary.callbackUrl = callbackUrl;
      }
    }
    return summary;
  }

  private toPendingWhatsAppSummary(record: ChannelConnectionRecord): ChannelSummary {
    const replacingActive = record.state === 'connected' && Boolean(record.activeGeneration);
    const summary: ChannelSummary = {
      channel: 'whatsapp',
      state: 'needs_vendor_step',
      issueCode: record.pendingWebhookVerifiedAt
        ? replacingActive
          ? 'replacement_signed_callback_pending'
          : 'signed_callback_pending'
        : replacingActive
          ? 'replacement_webhook_verification_required'
          : 'webhook_verification_required',
    };
    if (record.pendingDisplayName) {
      summary.displayName = record.pendingDisplayName;
    }
    const callbackUrl = record.pendingCallbackId
      ? resolveTrustedCallbackUrl(
          record.publicBaseUrl || this.trustedPublicApiUrl,
          record.pendingCallbackId,
        )
      : undefined;
    if (callbackUrl) {
      summary.callbackUrl = callbackUrl;
    }
    return summary;
  }

  private toVisibleSummary(record: ChannelConnectionRecord): ChannelSummary {
    return record.channel === 'whatsapp' && record.pendingConfigGeneration
      ? this.toPendingWhatsAppSummary(record)
      : this.toSummary(record);
  }

  private ensureGeneration(record: ChannelConnectionRecord): string {
    if (!record.configGeneration) {
      record.configGeneration = crypto
        .createHash('sha256')
        .update(record.encryptedCredentials)
        .digest('hex');
    }
    return record.configGeneration;
  }

  private async serializeLifecycle<T>(channel: ChannelId, operation: () => Promise<T>): Promise<T> {
    const prior = this.lifecycleTails.get(channel) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.lifecycleTails.set(channel, current);
    try {
      return await current;
    } finally {
      if (this.lifecycleTails.get(channel) === current) {
        this.lifecycleTails.delete(channel);
      }
    }
  }

  private expectedPendingGeneration(
    record: ChannelConnectionRecord | null,
  ): string | null | undefined {
    return record?.channel === 'whatsapp' ? (record.pendingConfigGeneration ?? null) : undefined;
  }

  private async currentSummary(channel: ChannelId): Promise<ChannelSummary> {
    const current = await this.repository.findByChannel(channel);
    if (!current) {
      return { channel, state: 'not_configured' };
    }
    return this.toVisibleSummary(current);
  }

  private async supersededTestResponse(channel: ChannelId): Promise<ChannelTestResponse> {
    return {
      ok: false,
      channel: await this.currentSummary(channel),
      message: 'Channel settings changed while the test was running. Review the current state.',
    };
  }

  async list(): Promise<ChannelSummary[]> {
    const records = await this.repository.list();
    const byChannel = new Map(records.map((record) => [record.channel, record]));
    return CHANNEL_IDS.map((channel) => {
      const record = byChannel.get(channel);
      if (!record) {
        return { channel, state: 'not_configured' };
      }
      return this.toVisibleSummary(record);
    });
  }

  async availability(): Promise<Array<{ channel: ChannelId; available: boolean }>> {
    const records = await this.repository.list();
    const states = new Map(records.map((record) => [record.channel, record.state]));
    return CHANNEL_IDS.map((channel) => ({
      channel,
      available: states.get(channel) === 'connected',
    }));
  }

  async connect(
    channel: ChannelId,
    input: Record<string, unknown>,
    adminUserId: string,
  ): Promise<ChannelSummary> {
    return await this.serializeLifecycle(channel, () =>
      this.connectUnlocked(channel, input, adminUserId),
    );
  }

  private async connectUnlocked(
    channel: ChannelId,
    input: Record<string, unknown>,
    adminUserId: string,
  ): Promise<ChannelSummary> {
    const normalized = normalizeChannelConnectInput(channel, input);
    const stored = await this.repository.findByChannel(channel);
    const existing = stored?.state === 'disconnected' ? null : stored;
    const expectedGeneration = stored?.configGeneration ?? null;
    const expectedPendingGeneration = this.expectedPendingGeneration(stored);
    const encryptedCredentials = await this.vault.encrypt(normalized.credentials);
    const configGeneration = this.randomGeneration();
    const record: ChannelConnectionRecord = {
      channel,
      state: 'verifying',
      accountId: existing?.accountId || 'default',
      accountLabel: normalized.accountLabel,
      encryptedCredentials,
      callbackId:
        channel === 'whatsapp' && existing
          ? this.randomId()
          : existing?.callbackId || this.randomId(),
      publicBaseUrl:
        channel === 'whatsapp'
          ? normalized.publicBaseUrl || existing?.publicBaseUrl || this.trustedPublicApiUrl || null
          : null,
      createdBy: adminUserId,
      issueCode: null,
      displayName: existing?.displayName ?? null,
      lastVerifiedAt: existing?.lastVerifiedAt ?? null,
      webhookVerifiedAt: null,
      webhookSignedVerifiedAt: null,
      configGeneration,
      activeGeneration: existing?.activeGeneration ?? null,
    };
    if (!this.runtime.has(channel)) {
      if (existing) {
        return { ...this.toSummary(existing), issueCode: 'transport_unavailable' };
      }
      record.state = 'needs_vendor_step';
      record.issueCode = 'transport_unavailable';
      const saved = await this.repository.saveIfGeneration(
        expectedGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!saved) {
        throw new ChannelRepairRejectedError('configuration_superseded');
      }
      return this.toSummary(saved);
    }

    let staged = false;
    let workerActivated = false;
    try {
      const candidateConnection = {
        channel,
        accountId: record.accountId,
        credentials: normalized.credentials,
        configGeneration,
      };
      const testResult = await this.runtime.test(candidateConnection);
      record.displayName = testResult.displayName ?? null;
      record.accountId = testResult.accountId || record.accountId;
      record.lastVerifiedAt = new Date();
      if (!testResult.ok) {
        if (existing) {
          throw new ChannelRepairRejectedError(testResult.issueCode || 'connection_test_failed');
        }
        record.state = 'degraded';
        record.issueCode = testResult.issueCode || 'connection_test_failed';
        const saved = await this.repository.saveIfGeneration(
          expectedGeneration,
          record,
          expectedPendingGeneration,
        );
        if (!saved) {
          throw new ChannelRepairRejectedError('configuration_superseded');
        }
        return this.toSummary(saved);
      }
      if (channel === 'whatsapp' && !record.publicBaseUrl) {
        if (existing) {
          throw new ChannelRepairRejectedError('public_https_required');
        }
        record.state = 'needs_vendor_step';
        record.issueCode = 'public_https_required';
        const saved = await this.repository.saveIfGeneration(
          expectedGeneration,
          record,
          expectedPendingGeneration,
        );
        if (!saved) {
          throw new ChannelRepairRejectedError('configuration_superseded');
        }
        return this.toSummary(saved);
      }
      if (channel === 'whatsapp' && existing) {
        const staged = await this.repository.stageWhatsAppCandidate(
          existing.configGeneration ?? null,
          existing.pendingConfigGeneration ?? null,
          {
            ...existing,
            pendingEncryptedCredentials: encryptedCredentials,
            pendingCallbackId: record.callbackId,
            pendingAccountId: record.accountId,
            pendingAccountLabel: record.accountLabel ?? null,
            pendingDisplayName: record.displayName ?? null,
            pendingConfigGeneration: configGeneration,
            pendingWebhookVerifiedAt: null,
            publicBaseUrl: record.publicBaseUrl,
          },
        );
        if (!staged) {
          throw new ChannelRepairRejectedError('configuration_superseded');
        }
        return this.toPendingWhatsAppSummary(staged);
      }
      if (channel === 'whatsapp' && !record.webhookVerifiedAt) {
        record.state = 'needs_vendor_step';
        record.issueCode = 'webhook_verification_required';
        const saved = await this.repository.saveIfGeneration(
          expectedGeneration,
          record,
          expectedPendingGeneration,
        );
        if (!saved) {
          throw new ChannelRepairRejectedError('configuration_superseded');
        }
        return this.toSummary(saved);
      }
      const verifiedConnection = {
        channel,
        accountId: record.accountId,
        credentials: normalized.credentials,
        configGeneration,
      };
      record.state = 'verifying';
      record.issueCode = 'activation_pending';
      const stagedRecord = await this.repository.saveIfGeneration(
        expectedGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!stagedRecord) {
        throw new ChannelRepairRejectedError('configuration_superseded');
      }
      staged = true;
      if (existing && existing.accountId !== record.accountId) {
        await this.runtime
          .stop(channel, existing.accountId, existing.configGeneration ?? undefined)
          .catch(() => undefined);
      }
      const activated = await this.runtime.start(verifiedConnection, { mode: 'replace' });
      if (!activated) {
        return this.toSummary(stagedRecord);
      }
      workerActivated = true;
      record.state = 'connected';
      record.issueCode = null;
      record.activeGeneration = configGeneration;
      const activatedRecord = await this.repository.saveIfGeneration(configGeneration, record);
      if (!activatedRecord) {
        await this.runtime.stop(channel, record.accountId, configGeneration).catch(() => undefined);
        throw new ChannelRepairRejectedError('configuration_superseded');
      }
      return this.toSummary(activatedRecord);
    } catch (error) {
      if (error instanceof ChannelRepairRejectedError) {
        throw error;
      }
      if (existing) {
        if (workerActivated) {
          await this.runtime
            .stop(channel, record.accountId, configGeneration)
            .catch(() => undefined);
        }
        if (staged) {
          const restored = await this.repository.saveIfGeneration(configGeneration, existing);
          if (restored && existing.state === 'connected') {
            try {
              const priorCredentials = await this.vault.decrypt(existing.encryptedCredentials);
              await this.runtime.start(
                {
                  channel,
                  accountId: existing.accountId,
                  credentials: priorCredentials,
                  configGeneration: existing.configGeneration || undefined,
                },
                { mode: 'replace' },
              );
              const confirmed = await this.repository.saveIfGeneration(
                existing.configGeneration ?? null,
                restored,
                this.expectedPendingGeneration(existing),
              );
              if (!confirmed) {
                await this.runtime
                  .stop(channel, existing.accountId, existing.configGeneration ?? undefined)
                  .catch(() => undefined);
              }
            } catch {
              // The preserved record remains authoritative; reconciliation will retry activation.
            }
          }
        }
        throw new ChannelRepairRejectedError(issueCodeFromError(error, 'connection_unavailable'));
      }
      record.state = 'degraded';
      record.issueCode = issueCodeFromError(error, 'connection_unavailable');
      record.lastVerifiedAt = new Date();
      if (staged) {
        if (workerActivated) {
          await this.runtime
            .stop(channel, record.accountId, configGeneration)
            .catch(() => undefined);
        }
        const failedRecord = await this.repository.saveIfGeneration(configGeneration, record);
        if (!failedRecord) {
          throw new ChannelRepairRejectedError('configuration_superseded');
        }
        return this.toSummary(failedRecord);
      }
    }
    const failedRecord = await this.repository.saveIfGeneration(
      expectedGeneration,
      record,
      expectedPendingGeneration,
    );
    if (!failedRecord) {
      throw new ChannelRepairRejectedError('configuration_superseded');
    }
    return this.toSummary(failedRecord);
  }

  async test(channel: ChannelId): Promise<ChannelTestResponse> {
    return await this.serializeLifecycle(channel, () => this.testUnlocked(channel));
  }

  private async testUnlocked(channel: ChannelId): Promise<ChannelTestResponse> {
    const record = await this.repository.findByChannel(channel);
    if (!record || record.state === 'disconnected') {
      return {
        ok: false,
        channel: record ? this.toSummary(record) : { channel, state: 'not_configured' },
        message: 'Channel is not configured.',
      };
    }
    const expectedGeneration = record.configGeneration ?? null;
    const expectedPendingGeneration = this.expectedPendingGeneration(record);
    if (!this.runtime.has(channel)) {
      record.state = 'needs_vendor_step';
      record.issueCode = 'transport_unavailable';
      const saved = await this.repository.saveIfGeneration(
        expectedGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!saved) {
        return await this.supersededTestResponse(channel);
      }
      return {
        ok: false,
        channel: this.toVisibleSummary(saved),
        message: 'The channel transport is not available in this runtime.',
      };
    }

    let credentials: Record<string, string>;
    try {
      credentials = await this.vault.decrypt(record.encryptedCredentials);
    } catch {
      record.state = 'reauth_required';
      record.issueCode = 'credentials_unavailable';
      record.lastVerifiedAt = new Date();
      const saved = await this.repository.saveIfGeneration(
        expectedGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!saved) {
        return await this.supersededTestResponse(channel);
      }
      return {
        ok: false,
        channel: this.toVisibleSummary(saved),
        message: 'Channel credentials must be entered again.',
      };
    }
    let configGeneration = this.ensureGeneration(record);
    if (expectedGeneration === null) {
      const generated = await this.repository.saveIfGeneration(
        null,
        record,
        expectedPendingGeneration,
      );
      if (!generated) {
        return await this.supersededTestResponse(channel);
      }
    }
    const testGeneration = this.randomGeneration();
    record.configGeneration = testGeneration;
    const claimed = await this.repository.saveIfGeneration(
      configGeneration,
      record,
      expectedPendingGeneration,
    );
    if (!claimed) {
      return await this.supersededTestResponse(channel);
    }
    configGeneration = testGeneration;
    const priorAccountId = record.accountId;
    const priorActiveGeneration = record.activeGeneration ?? undefined;
    let workerActivated = false;
    try {
      const result = await this.runtime.test({
        channel,
        accountId: record.accountId,
        credentials,
        configGeneration,
      });
      record.accountId = result.accountId || record.accountId;
      record.displayName = result.displayName ?? record.displayName ?? null;
      record.lastVerifiedAt = new Date();
      if (!result.ok) {
        record.state = ['invalid_credentials', 'missing_permission'].includes(
          result.issueCode || '',
        )
          ? 'reauth_required'
          : 'degraded';
        record.issueCode = result.issueCode || 'connection_test_failed';
        const saved = await this.repository.saveIfGeneration(
          configGeneration,
          record,
          expectedPendingGeneration,
        );
        if (!saved) {
          return await this.supersededTestResponse(channel);
        }
        if (priorActiveGeneration) {
          await this.runtime
            .stop(channel, priorAccountId, priorActiveGeneration)
            .catch(() => undefined);
        }
        return {
          ok: false,
          channel: this.toVisibleSummary(saved),
          message: 'Channel connection could not be verified.',
        };
      } else if (
        channel === 'whatsapp' &&
        (!record.webhookVerifiedAt || !record.webhookSignedVerifiedAt)
      ) {
        record.state = 'needs_vendor_step';
        record.issueCode = !record.webhookVerifiedAt
          ? 'webhook_verification_required'
          : 'signed_callback_pending';
        const saved = await this.repository.saveIfGeneration(
          configGeneration,
          record,
          expectedPendingGeneration,
        );
        if (!saved) {
          return await this.supersededTestResponse(channel);
        }
        if (priorActiveGeneration) {
          await this.runtime
            .stop(channel, priorAccountId, priorActiveGeneration)
            .catch(() => undefined);
        }
        return {
          ok: false,
          channel: this.toVisibleSummary(saved),
          message: 'Channel connection could not be verified.',
        };
      } else {
        record.state = 'verifying';
        record.issueCode = 'activation_pending';
        const staged = await this.repository.saveIfGeneration(
          configGeneration,
          record,
          expectedPendingGeneration,
        );
        if (!staged) {
          return await this.supersededTestResponse(channel);
        }
        if (priorAccountId !== record.accountId && priorActiveGeneration) {
          await this.runtime
            .stop(channel, priorAccountId, priorActiveGeneration)
            .catch(() => undefined);
        }
        const activated = await this.runtime.start(
          { channel, accountId: record.accountId, credentials, configGeneration },
          { mode: 'replace' },
        );
        workerActivated = activated;
        record.state = activated ? 'connected' : 'verifying';
        record.activeGeneration = activated ? configGeneration : record.activeGeneration;
      }
      record.issueCode = record.state === 'verifying' ? 'activation_pending' : null;
      const saved = await this.repository.saveIfGeneration(
        configGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!saved) {
        if (workerActivated) {
          await this.runtime
            .stop(channel, record.accountId, configGeneration)
            .catch(() => undefined);
        }
        return await this.supersededTestResponse(channel);
      }
      return {
        ok: saved.state === 'connected',
        channel: this.toVisibleSummary(saved),
        message:
          saved.state === 'connected'
            ? 'Channel connection verified.'
            : 'Channel connection could not be verified.',
      };
    } catch (error) {
      record.state = 'degraded';
      record.issueCode = issueCodeFromError(error, 'connection_unavailable');
      record.lastVerifiedAt = new Date();
      if (workerActivated) {
        await this.runtime.stop(channel, record.accountId, configGeneration).catch(() => undefined);
      }
      const saved = await this.repository.saveIfGeneration(
        configGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!saved) {
        return await this.supersededTestResponse(channel);
      }
      return {
        ok: false,
        channel: this.toVisibleSummary(saved),
        message: 'The channel provider or worker is temporarily unavailable.',
      };
    }
  }

  async disconnect(channel: ChannelId): Promise<ChannelSummary> {
    return await this.serializeLifecycle(channel, () => this.disconnectUnlocked(channel));
  }

  private async disconnectUnlocked(channel: ChannelId): Promise<ChannelSummary> {
    const existing = await this.repository.findByChannel(channel);
    const expectedGeneration = existing?.configGeneration ?? null;
    const expectedPendingGeneration = this.expectedPendingGeneration(existing);
    const accountId = existing?.accountId || 'default';
    const disconnected: ChannelConnectionRecord = {
      channel,
      state: 'disconnected',
      accountId,
      accountLabel: null,
      displayName: null,
      encryptedCredentials: await this.vault.encrypt({}),
      callbackId: this.randomId(),
      publicBaseUrl: null,
      issueCode: null,
      lastVerifiedAt: null,
      webhookVerifiedAt: null,
      webhookSignedVerifiedAt: null,
      configGeneration: this.randomGeneration(),
      activeGeneration: null,
      pendingEncryptedCredentials: null,
      pendingCallbackId: null,
      pendingAccountId: null,
      pendingAccountLabel: null,
      pendingDisplayName: null,
      pendingConfigGeneration: null,
      pendingWebhookVerifiedAt: null,
      createdBy: existing?.createdBy ?? null,
    };
    let saved = await this.repository.saveIfGeneration(
      expectedGeneration,
      disconnected,
      expectedPendingGeneration,
    );
    if (!saved) {
      return await this.currentSummary(channel);
    }
    if (existing && this.runtime.has(channel)) {
      try {
        await this.runtime.stop(channel, accountId, existing.configGeneration ?? undefined);
      } catch {
        saved.issueCode = 'worker_stop_failed';
        const stopFailure = await this.repository.saveIfGeneration(
          disconnected.configGeneration ?? null,
          saved,
          channel === 'whatsapp' ? null : undefined,
        );
        if (!stopFailure) {
          return await this.currentSummary(channel);
        }
        saved = stopFailure;
      }
    }
    return this.toSummary(saved);
  }

  async restore(onlyChannels?: ReadonlyArray<ChannelId>): Promise<void> {
    const snapshots = await this.repository.list();
    for (const snapshot of snapshots) {
      if (onlyChannels && !onlyChannels.includes(snapshot.channel)) {
        continue;
      }
      await this.serializeLifecycle(snapshot.channel, async () => {
        const record = await this.repository.findByChannel(snapshot.channel);
        if (!record || !['connected', 'verifying', 'degraded'].includes(record.state)) {
          return;
        }
        if (record.channel === 'whatsapp' && !record.webhookSignedVerifiedAt) {
          return;
        }
        if (!this.runtime.has(record.channel)) {
          return;
        }
        const expectedGeneration = record.configGeneration ?? null;
        const expectedPendingGeneration = this.expectedPendingGeneration(record);
        let credentials: Record<string, string>;
        try {
          credentials = await this.vault.decrypt(record.encryptedCredentials);
        } catch {
          record.state = 'reauth_required';
          record.issueCode = 'credentials_unavailable';
          await this.repository.saveIfGeneration(
            expectedGeneration,
            record,
            expectedPendingGeneration,
          );
          return;
        }
        const configGeneration = this.ensureGeneration(record);
        if (expectedGeneration === null) {
          const generationSaved = await this.repository.saveIfGeneration(
            null,
            record,
            expectedPendingGeneration,
          );
          if (!generationSaved) {
            return;
          }
        }
        try {
          const activated = await this.runtime.start({
            channel: record.channel,
            accountId: record.accountId,
            credentials,
            configGeneration,
          });
          if (!activated) {
            return;
          }
          record.state = 'connected';
          record.issueCode = null;
          record.activeGeneration = configGeneration;
          const saved = await this.repository.saveIfGeneration(
            configGeneration,
            record,
            expectedPendingGeneration,
          );
          if (!saved) {
            await this.runtime
              .stop(record.channel, record.accountId, configGeneration)
              .catch(() => undefined);
          }
        } catch (error) {
          record.state = 'degraded';
          record.issueCode = issueCodeFromError(error, 'connection_unavailable');
          await this.repository.saveIfGeneration(
            configGeneration,
            record,
            expectedPendingGeneration,
          );
        }
      });
    }
  }

  async getWhatsAppWebhookSecrets(callbackId: string): Promise<WhatsAppWebhookSecrets | null> {
    if (!/^[a-f0-9-]{20,128}$/i.test(callbackId)) {
      return null;
    }
    const record = await this.repository.findByCallbackId(callbackId);
    if (!record || record.channel !== 'whatsapp' || record.state === 'disconnected') {
      return null;
    }
    try {
      const encryptedCredentials =
        record.pendingCallbackId === callbackId
          ? record.pendingEncryptedCredentials
          : record.encryptedCredentials;
      if (!encryptedCredentials) {
        return null;
      }
      const credentials = await this.vault.decrypt(encryptedCredentials);
      const appSecret = credentials.appSecret;
      const verifyToken = credentials.verifyToken;
      return appSecret && verifyToken ? { appSecret, verifyToken } : null;
    } catch {
      return null;
    }
  }

  async getWhatsAppWebhookConnection(callbackId: string): Promise<{
    channel: 'whatsapp';
    accountId: string;
    credentials: Record<string, string>;
  } | null> {
    if (!/^[a-f0-9-]{20,128}$/i.test(callbackId)) {
      return null;
    }
    const record = await this.repository.findByCallbackId(callbackId);
    if (!record || record.channel !== 'whatsapp' || record.state === 'disconnected') {
      return null;
    }
    try {
      const encryptedCredentials =
        record.pendingCallbackId === callbackId
          ? record.pendingEncryptedCredentials
          : record.encryptedCredentials;
      if (!encryptedCredentials) {
        return null;
      }
      return {
        channel: 'whatsapp',
        accountId:
          record.pendingCallbackId === callbackId
            ? record.pendingAccountId || record.accountId
            : record.accountId,
        credentials: await this.vault.decrypt(encryptedCredentials),
      };
    } catch {
      return null;
    }
  }

  async markWhatsAppWebhookVerified(callbackId: string): Promise<boolean> {
    return await this.serializeLifecycle('whatsapp', () =>
      this.markWhatsAppWebhookVerifiedUnlocked(callbackId),
    );
  }

  private async markWhatsAppWebhookVerifiedUnlocked(callbackId: string): Promise<boolean> {
    const record = await this.repository.findByCallbackId(callbackId);
    if (!record || record.channel !== 'whatsapp' || record.state === 'disconnected') {
      return false;
    }
    if (record.pendingCallbackId === callbackId) {
      if (!record.pendingConfigGeneration || !record.pendingEncryptedCredentials) {
        return false;
      }
      record.pendingWebhookVerifiedAt = new Date();
      return Boolean(
        await this.repository.saveWhatsAppCandidate(
          record.configGeneration ?? null,
          record.pendingConfigGeneration,
          record,
        ),
      );
    }
    if (
      record.state === 'connected' &&
      record.webhookSignedVerifiedAt &&
      record.configGeneration &&
      record.activeGeneration === record.configGeneration
    ) {
      return true;
    }
    const expectedGeneration = record.configGeneration ?? null;
    const expectedPendingGeneration = record.pendingConfigGeneration ?? null;
    try {
      const credentials = await this.vault.decrypt(record.encryptedCredentials);
      record.webhookVerifiedAt = new Date();
      record.state = 'verifying';
      record.issueCode = 'signed_callback_pending';
      const saved = await this.repository.saveIfGeneration(
        expectedGeneration,
        record,
        expectedPendingGeneration,
      );
      void credentials;
      return Boolean(saved);
    } catch {
      record.state = 'degraded';
      record.issueCode = 'worker_start_failed';
      await this.repository.saveIfGeneration(expectedGeneration, record, expectedPendingGeneration);
      return false;
    }
  }

  async markWhatsAppSignedCallbackVerified(callbackId: string): Promise<boolean> {
    return await this.serializeLifecycle('whatsapp', () =>
      this.markWhatsAppSignedCallbackVerifiedUnlocked(callbackId),
    );
  }

  private async markWhatsAppSignedCallbackVerifiedUnlocked(callbackId: string): Promise<boolean> {
    const record = await this.repository.findByCallbackId(callbackId);
    const isPendingCandidate = record?.pendingCallbackId === callbackId;
    const webhookVerifiedAt = isPendingCandidate
      ? record?.pendingWebhookVerifiedAt
      : record?.webhookVerifiedAt;
    if (!record || record.channel !== 'whatsapp' || !webhookVerifiedAt) {
      return false;
    }
    if (isPendingCandidate) {
      return await this.activatePendingWhatsAppCandidate(record);
    }
    if (
      record.state === 'connected' &&
      record.webhookSignedVerifiedAt &&
      record.configGeneration &&
      record.activeGeneration === record.configGeneration
    ) {
      return true;
    }
    const expectedGeneration = record.configGeneration ?? null;
    const expectedPendingGeneration = record.pendingConfigGeneration ?? null;
    let mutationGeneration = expectedGeneration;
    let workerActivated = false;
    try {
      const credentials = await this.vault.decrypt(record.encryptedCredentials);
      const configGeneration = this.ensureGeneration(record);
      if (expectedGeneration === null) {
        const generated = await this.repository.saveIfGeneration(
          null,
          record,
          expectedPendingGeneration,
        );
        if (!generated) {
          return false;
        }
      }
      mutationGeneration = configGeneration;
      const candidate = {
        channel: 'whatsapp' as const,
        accountId: record.accountId,
        credentials,
        configGeneration,
      };
      const result = await this.runtime.test(candidate);
      if (!result.ok) {
        record.state = ['invalid_credentials', 'missing_permission'].includes(
          result.issueCode || '',
        )
          ? 'reauth_required'
          : 'degraded';
        record.issueCode = result.issueCode || 'connection_test_failed';
        record.lastVerifiedAt = new Date();
        await this.repository.saveIfGeneration(configGeneration, record, expectedPendingGeneration);
        return false;
      }
      record.accountId = result.accountId || record.accountId;
      record.webhookSignedVerifiedAt = new Date();
      record.state = 'verifying';
      record.issueCode = 'activation_pending';
      record.lastVerifiedAt = new Date();
      const staged = await this.repository.stageActivation(
        configGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!staged) {
        const current = await this.repository.findByChannel('whatsapp');
        return Boolean(
          current?.state === 'connected' &&
          current.configGeneration === configGeneration &&
          current.activeGeneration === configGeneration,
        );
      }
      const activated = await this.runtime.start(
        { ...candidate, accountId: record.accountId },
        { mode: 'replace' },
      );
      if (!activated) {
        return false;
      }
      workerActivated = true;
      record.state = 'connected';
      record.issueCode = null;
      record.activeGeneration = configGeneration;
      const saved = await this.repository.saveIfGeneration(
        configGeneration,
        record,
        expectedPendingGeneration,
      );
      if (!saved) {
        await this.runtime
          .stop('whatsapp', record.accountId, configGeneration)
          .catch(() => undefined);
        return false;
      }
      return true;
    } catch (error) {
      if (workerActivated) {
        await this.runtime
          .stop('whatsapp', record.accountId, mutationGeneration ?? undefined)
          .catch(() => undefined);
      }
      record.state = 'degraded';
      record.issueCode = issueCodeFromError(error, 'worker_start_failed');
      await this.repository.saveIfGeneration(mutationGeneration, record, expectedPendingGeneration);
      return false;
    }
  }

  private async activatePendingWhatsAppCandidate(
    record: ChannelConnectionRecord,
  ): Promise<boolean> {
    const pendingGeneration = record.pendingConfigGeneration;
    const pendingCredentialsCipher = record.pendingEncryptedCredentials;
    const pendingCallbackId = record.pendingCallbackId;
    if (!pendingGeneration || !pendingCredentialsCipher || !pendingCallbackId) {
      return false;
    }
    const previous = { ...record };
    let promoted = false;
    try {
      const credentials = await this.vault.decrypt(pendingCredentialsCipher);
      const candidate = {
        channel: 'whatsapp' as const,
        accountId: record.pendingAccountId || record.accountId,
        credentials,
        configGeneration: pendingGeneration,
      };
      const result = await this.runtime.test(candidate);
      if (!result.ok) {
        return false;
      }
      candidate.accountId = result.accountId || candidate.accountId;
      const promotedRecord: ChannelConnectionRecord = {
        ...record,
        state: 'verifying',
        accountId: candidate.accountId,
        accountLabel: record.pendingAccountLabel ?? null,
        displayName: result.displayName ?? record.pendingDisplayName ?? null,
        encryptedCredentials: pendingCredentialsCipher,
        callbackId: pendingCallbackId,
        issueCode: 'activation_pending',
        lastVerifiedAt: new Date(),
        webhookVerifiedAt: record.pendingWebhookVerifiedAt,
        webhookSignedVerifiedAt: new Date(),
        configGeneration: pendingGeneration,
        pendingEncryptedCredentials: null,
        pendingCallbackId: null,
        pendingAccountId: null,
        pendingAccountLabel: null,
        pendingDisplayName: null,
        pendingConfigGeneration: null,
        pendingWebhookVerifiedAt: null,
      };
      const staged = await this.repository.promoteWhatsAppCandidate(
        record.configGeneration ?? null,
        pendingGeneration,
        promotedRecord,
      );
      if (!staged) {
        return false;
      }
      promoted = true;
      const activated = await this.runtime.start(candidate, { mode: 'replace' });
      if (!activated) {
        throw Object.assign(new Error('channel activation pending'), {
          issueCode: 'activation_pending',
        });
      }
      promotedRecord.state = 'connected';
      promotedRecord.issueCode = null;
      promotedRecord.activeGeneration = pendingGeneration;
      const saved = await this.repository.saveIfGeneration(pendingGeneration, promotedRecord, null);
      if (!saved) {
        await this.runtime
          .stop('whatsapp', candidate.accountId, pendingGeneration)
          .catch(() => undefined);
        throw new Error('channel activation was superseded before persistence');
      }
      return true;
    } catch {
      if (promoted) {
        const restored = await this.repository.saveIfGeneration(pendingGeneration, previous, null);
        if (restored && previous.state === 'connected') {
          try {
            const priorCredentials = await this.vault.decrypt(previous.encryptedCredentials);
            await this.runtime.start(
              {
                channel: 'whatsapp',
                accountId: previous.accountId,
                credentials: priorCredentials,
                configGeneration: previous.configGeneration || undefined,
              },
              { mode: 'replace' },
            );
            const confirmed = await this.repository.saveIfGeneration(
              previous.configGeneration ?? null,
              restored,
              previous.pendingConfigGeneration ?? null,
            );
            if (!confirmed) {
              await this.runtime
                .stop('whatsapp', previous.accountId, previous.configGeneration ?? undefined)
                .catch(() => undefined);
            }
          } catch {
            // The active record remains authoritative; reconciliation retries activation.
          }
        }
      }
      return false;
    }
  }
}
