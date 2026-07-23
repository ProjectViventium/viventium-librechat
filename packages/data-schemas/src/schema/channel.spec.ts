/**
 * === VIVENTIUM START ===
 * Feature: Connected channel persistence contracts.
 * Purpose: Prevent cross-account identity/thread collisions and secret-bearing connection drift.
 * === VIVENTIUM END ===
 */

import channelConnectionSchema from './channelConnection';
import channelIngressQuotaSchema from './channelIngressQuota';
import channelThreadSchema from './channelThread';
import gatewayLinkTokenSchema from './gatewayLinkToken';
import gatewayUserMappingSchema from './gatewayUserMapping';
import viventiumGatewayIngressEventSchema from './viventiumGatewayIngressEvent';

function hasIndex(
  indexes: ReturnType<typeof channelConnectionSchema.indexes>,
  fields: Record<string, number>,
  option?: { name: string; value: boolean | number },
) {
  return indexes.some(([indexFields, options]) => {
    if (JSON.stringify(indexFields) !== JSON.stringify(fields)) {
      return false;
    }
    return option == null || options[option.name] === option.value;
  });
}

describe('connected channel schemas', () => {
  it('stores one encrypted connection per supported channel without plaintext secret fields', () => {
    expect(
      hasIndex(channelConnectionSchema.indexes(), { channel: 1 }, { name: 'unique', value: true }),
    ).toBe(true);
    expect(channelConnectionSchema.path('encryptedCredentials')).toBeDefined();
    expect(channelConnectionSchema.path('callbackId')).toBeDefined();
    expect(channelConnectionSchema.path('botToken')).toBeUndefined();
    expect(channelConnectionSchema.path('appToken')).toBeUndefined();
    expect(channelConnectionSchema.path('accessToken')).toBeUndefined();
  });

  it('scopes linked identities and durable threads by channel and provider account', () => {
    expect(
      hasIndex(
        gatewayUserMappingSchema.indexes(),
        { channel: 1, accountId: 1, externalUserId: 1 },
        { name: 'unique', value: true },
      ),
    ).toBe(true);
    expect(
      hasIndex(
        channelThreadSchema.indexes(),
        {
          channel: 1,
          accountId: 1,
          externalConversationId: 1,
          externalThreadId: 1,
          libreChatUserId: 1,
        },
        { name: 'unique', value: true },
      ),
    ).toBe(true);
  });

  it('expires one-use links and ingress reservations through Mongo TTL indexes', () => {
    expect(
      hasIndex(
        gatewayLinkTokenSchema.indexes(),
        { expiresAt: 1 },
        { name: 'expireAfterSeconds', value: 0 },
      ),
    ).toBe(true);
    expect(
      hasIndex(
        viventiumGatewayIngressEventSchema.indexes(),
        { expiresAt: 1 },
        { name: 'expireAfterSeconds', value: 0 },
      ),
    ).toBe(true);
    expect(
      hasIndex(
        viventiumGatewayIngressEventSchema.indexes(),
        { dedupeKey: 1 },
        { name: 'unique', value: true },
      ),
    ).toBe(true);
  });

  it('stores ingress quotas as one bounded atomic bucket per scope and window', () => {
    expect(
      hasIndex(
        channelIngressQuotaSchema.indexes(),
        { quotaKey: 1 },
        { name: 'unique', value: true },
      ),
    ).toBe(true);
    expect(channelIngressQuotaSchema.path('eventKeys')).toBeDefined();
    expect(channelIngressQuotaSchema.path('count')).toBeDefined();
    expect(channelIngressQuotaSchema.path('dedupeKey')).toBeUndefined();
  });
});
