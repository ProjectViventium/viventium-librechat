const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const models = createModels(mongoose);
/* === VIVENTIUM START ===
 * Feature: Telegram user mapping models
 * Purpose: Persist Telegram <-> LibreChat account links and short-lived link tokens.
 * Added: 2026-01-31
 */
const createTelegramUserMapping = require('./telegramUserMapping');
const createTelegramLinkToken = require('./telegramLinkToken');
/* === VIVENTIUM END === */
/* === VIVENTIUM START ===
 * Feature: Voice call session persistence (Mongo TTL)
 * Purpose: Persist voice call sessions and expire them automatically (TTL).
 * Added: 2026-02-07
 */
const createViventiumCallSession = require('./viventiumCallSession');
/* === VIVENTIUM END === */
/* === VIVENTIUM START ===
 * Feature: Voice ingress coalescing model.
 * Added: 2026-04-20
 * === VIVENTIUM END === */
const createViventiumVoiceIngressEvent = require('./viventiumVoiceIngressEvent');
/* === VIVENTIUM START ===
 * Feature: Credits purchase request audit model.
 * Added: 2026-02-18
 * === VIVENTIUM END === */
const createViventiumCreditsRequest = require('./viventiumCreditsRequest');
/* === VIVENTIUM START ===
 * Feature: Telegram ingress idempotency model.
 * Added: 2026-02-18
 * === VIVENTIUM END === */
const createViventiumTelegramIngressEvent = require('./viventiumTelegramIngressEvent');
/* === VIVENTIUM START ===
 * Feature: Generic gateway mapping + link + ingress models.
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const createGatewayUserMapping = require('./gatewayUserMapping');
const createGatewayLinkToken = require('./gatewayLinkToken');
const createViventiumGatewayIngressEvent = require('./viventiumGatewayIngressEvent');
/* === VIVENTIUM START ===
 * Feature: Durable GlassHive callback delivery ledger.
 * Added: 2026-05-06
 * === VIVENTIUM END === */
const createViventiumGlassHiveCallbackDelivery = require('./viventiumGlassHiveCallbackDelivery');

/* === VIVENTIUM START ===
 * Feature: Viventium persistence models (Telegram + voice + gateway)
 * Purpose: Export Viventium-owned mongoose models from the central LibreChat models registry.
 * Added: 2026-01-31 (Telegram), 2026-02-07 (voice), 2026-02-19 (gateway)
 */
module.exports = {
  ...models,
  TelegramUserMapping: createTelegramUserMapping(mongoose),
  TelegramLinkToken: createTelegramLinkToken(mongoose),
  GatewayUserMapping: createGatewayUserMapping(mongoose),
  GatewayLinkToken: createGatewayLinkToken(mongoose),
  ViventiumCallSession: createViventiumCallSession(mongoose),
  ViventiumVoiceIngressEvent: createViventiumVoiceIngressEvent(mongoose),
  ViventiumCreditsRequest: createViventiumCreditsRequest(mongoose),
  ViventiumTelegramIngressEvent: createViventiumTelegramIngressEvent(mongoose),
  ViventiumGatewayIngressEvent: createViventiumGatewayIngressEvent(mongoose),
  ViventiumGlassHiveCallbackDelivery: createViventiumGlassHiveCallbackDelivery(mongoose),
};
/* === VIVENTIUM END === */
