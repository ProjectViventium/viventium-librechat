/**
 * === VIVENTIUM START ===
 * Feature: Official WhatsApp Cloud API webhook security.
 * Purpose: Verify Meta's raw-body HMAC before parsing or trusting webhook identifiers.
 * === VIVENTIUM END ===
 */

import crypto from 'node:crypto';

function constantTimeHexEqual(expectedHex: string, providedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
export function verifyWhatsAppSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=') || appSecret.length === 0) {
    return false;
  }
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return constantTimeHexEqual(expected, signatureHeader.slice('sha256='.length));
}

export function constantTimeSecretEqual(expectedSecret: string, providedSecret: string): boolean {
  const expectedDigest = crypto.createHash('sha256').update(expectedSecret).digest();
  const providedDigest = crypto.createHash('sha256').update(providedSecret).digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}
