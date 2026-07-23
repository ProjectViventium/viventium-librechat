/**
 * === VIVENTIUM START ===
 * Feature: Local-friendly channel pairing.
 * Purpose: Bind a channel identity with hashed one-use codes without sending commands to the agent.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';
import type { ChannelId } from './types';

export type ChannelPairingScope = {
  channel: ChannelId;
  accountId: string;
  externalUserId: string;
  externalUsername: string;
};

export type ChannelPairingCodeRecord = {
  tokenHash: string;
  channel: ChannelId;
  accountId: string;
  libreChatUserId: string;
  expiresAt: Date;
  consumedAt?: Date | null;
};

export interface ChannelPairingRepository {
  invalidate(
    channel: ChannelId,
    accountId: string,
    libreChatUserId: string,
    now: Date,
  ): Promise<void>;
  create(record: ChannelPairingCodeRecord): Promise<void>;
  consumeAndBind(
    tokenHash: string,
    scope: ChannelPairingScope,
    now: Date,
  ): Promise<ChannelPairingCodeRecord | null>;
  reserveAttempt(
    scopeKey: string,
    maximumAttempts: number,
    windowExpiresAt: Date,
  ): Promise<boolean>;
}

type ChannelPairingOptions = {
  repository: ChannelPairingRepository;
  randomCode?: () => string;
  now?: () => Date;
  ttlMinutes?: number;
  maximumAttempts?: number;
  attemptWindowMinutes?: number;
};

function defaultRandomCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const raw = Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashPairingCode(value: string): string {
  return hash(normalizeCode(value));
}

export class ChannelPairingService {
  private readonly repository: ChannelPairingRepository;
  private readonly randomCode: () => string;
  private readonly now: () => Date;
  private readonly ttlMinutes: number;
  private readonly maximumAttempts: number;
  private readonly attemptWindowMinutes: number;

  constructor(options: ChannelPairingOptions) {
    this.repository = options.repository;
    this.randomCode = options.randomCode ?? defaultRandomCode;
    this.now = options.now ?? (() => new Date());
    this.ttlMinutes = options.ttlMinutes ?? 10;
    this.maximumAttempts = options.maximumAttempts ?? 6;
    this.attemptWindowMinutes = options.attemptWindowMinutes ?? 15;
  }

  async create(
    channel: ChannelId,
    accountId: string,
    libreChatUserId: string,
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = normalizeCode(this.randomCode());
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMinutes * 60_000);
    await this.repository.invalidate(channel, accountId, libreChatUserId, now);
    await this.repository.create({
      tokenHash: hash(code),
      channel,
      accountId,
      libreChatUserId,
      expiresAt,
      consumedAt: null,
    });
    return { code, expiresAt };
  }

  async consume(
    scope: ChannelPairingScope,
    providedCode: string,
  ): Promise<{ ok: true } | { ok: false; error: 'invalid_or_expired' | 'rate_limited' }> {
    const code = normalizeCode(providedCode);
    return await this.consumeHash(scope, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? hash(code) : '');
  }

  async consumeHash(
    scope: ChannelPairingScope,
    tokenHash: string,
  ): Promise<{ ok: true } | { ok: false; error: 'invalid_or_expired' | 'rate_limited' }> {
    const now = this.now();
    const scopeKey = hash(JSON.stringify([scope.channel, scope.accountId, scope.externalUserId]));
    const windowExpiresAt = new Date(now.getTime() + this.attemptWindowMinutes * 60_000);
    const allowed = await this.repository.reserveAttempt(
      scopeKey,
      this.maximumAttempts,
      windowExpiresAt,
    );
    if (!allowed) {
      return { ok: false, error: 'rate_limited' };
    }
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
      return { ok: false, error: 'invalid_or_expired' };
    }
    const record = await this.repository.consumeAndBind(tokenHash, scope, now);
    if (!record || record.channel !== scope.channel || record.accountId !== scope.accountId) {
      return { ok: false, error: 'invalid_or_expired' };
    }
    return { ok: true };
  }
}
