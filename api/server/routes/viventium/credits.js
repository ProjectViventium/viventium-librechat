/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Credits purchase request endpoint
 *
 * Endpoint:
 * - POST /api/viventium/credits/request
 *
 * Added: 2026-02-18
 * === VIVENTIUM END === */

const express = require('express');
const fetch = require('node-fetch');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getUserById } = require('~/models');
const { Balance, ViventiumCreditsRequest } = require('~/db/models');
const { sendAdminMessage } = require('~/server/services/viventium/telegramNotifier');

const router = express.Router();

const NORTH_AMERICA_COUNTRY_CODES = new Set([
  'AG',
  'AI',
  'AW',
  'BB',
  'BL',
  'BM',
  'BQ',
  'BS',
  'BZ',
  'CA',
  'CR',
  'CU',
  'CW',
  'DM',
  'DO',
  'GD',
  'GL',
  'GP',
  'GT',
  'HN',
  'HT',
  'JM',
  'KN',
  'KY',
  'LC',
  'MF',
  'MQ',
  'MS',
  'MX',
  'NI',
  'PA',
  'PM',
  'PR',
  'SV',
  'SX',
  'TC',
  'TT',
  'US',
  'VC',
  'VG',
  'VI',
]);

const EUROPE_COUNTRY_CODES = new Set([
  'AD',
  'AL',
  'AT',
  'AX',
  'BA',
  'BE',
  'BG',
  'BY',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FO',
  'FR',
  'GB',
  'GG',
  'GI',
  'GR',
  'HR',
  'HU',
  'IE',
  'IM',
  'IS',
  'IT',
  'JE',
  'LI',
  'LT',
  'LU',
  'LV',
  'MC',
  'MD',
  'ME',
  'MK',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'RS',
  'RU',
  'SE',
  'SI',
  'SJ',
  'SK',
  'SM',
  'UA',
  'VA',
  'XK',
]);

function resolveRequestUserId(req) {
  if (typeof req.user?.id === 'string' && req.user.id) {
    return req.user.id;
  }
  if (req.user?._id?.toString) {
    return req.user._id.toString();
  }
  return '';
}

function resolveClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const raw =
    (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : '') || req.ip || req.socket?.remoteAddress || '';
  return String(raw).replace('::ffff:', '').trim();
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function continentFromCountryCode(countryCode) {
  const normalized = (countryCode || '').toUpperCase();
  if (!normalized) {
    return '';
  }
  if (NORTH_AMERICA_COUNTRY_CODES.has(normalized)) {
    return 'NA';
  }
  if (EUROPE_COUNTRY_CODES.has(normalized)) {
    return 'EU';
  }
  return '';
}

function isGeoAllowed({ continentCode }) {
  return continentCode === 'NA' || continentCode === 'EU';
}

async function lookupIpGeo(ip) {
  if (!ip) {
    return {
      continentCode: '',
      continentName: '',
      countryCode: '',
      country: '',
      city: '',
    };
  }

  const token = (process.env.IPINFO_TOKEN || process.env.VIVENTIUM_IPINFO_TOKEN || '').trim();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json${tokenParam}`;

  try {
    const payload = await fetchJson(url, 5000);
    const countryCode = String(payload?.country || '').toUpperCase();
    const continentCode =
      String(payload?.continent_code || payload?.continent || '').toUpperCase() ||
      continentFromCountryCode(countryCode);
    return {
      continentCode,
      continentName:
        continentCode === 'NA'
          ? 'North America'
          : continentCode === 'EU'
            ? 'Europe'
            : String(payload?.continent_name || ''),
      countryCode,
      country: String(payload?.country_name || payload?.country || ''),
      city: String(payload?.city || ''),
    };
  } catch (error) {
    logger.warn('[VIVENTIUM][credits] IP geolocation lookup failed', { ip, error: String(error) });
    return {
      continentCode: '',
      continentName: '',
      countryCode: '',
      country: '',
      city: '',
    };
  }
}

router.post('/request', requireJwtAuth, async (req, res) => {
  try {
    const userId = resolveRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const cooldownHoursRaw = Number.parseInt(process.env.VIVENTIUM_CREDITS_REQUEST_COOLDOWN_HOURS || '24', 10);
    const cooldownHours = Number.isFinite(cooldownHoursRaw) && cooldownHoursRaw > 0 ? cooldownHoursRaw : 24;
    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const previous = await ViventiumCreditsRequest.findOne({
      userId,
      createdAt: { $gte: cutoff },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (previous) {
      return res.status(200).json({
        success: true,
        cooldown: true,
        message:
          "We've already received your request recently. Please wait a bit before submitting another one.",
      });
    }

    const user = await getUserById(userId, 'email username name');
    const ip = resolveClientIp(req);
    const geo = await lookupIpGeo(ip);
    const geoFilterEnabled = isEnabled(process.env.VIVENTIUM_GEO_FILTER_ENABLED);
    const shouldNotifyAdmin = !geoFilterEnabled || isGeoAllowed(geo);

    const balanceDoc = await Balance.findOne({ user: userId }).lean().catch(() => null);
    const currentBalance =
      typeof balanceDoc?.tokenCredits === 'number' ? Math.round(balanceDoc.tokenCredits) : null;

    const record = await ViventiumCreditsRequest.create({
      userId,
      email: user?.email || '',
      name: user?.name || user?.username || '',
      ip,
      continentCode: geo.continentCode,
      continentName: geo.continentName,
      countryCode: geo.countryCode,
      country: geo.country,
      city: geo.city,
      status: 'requested',
      notifiedAdmin: false,
    });

    let notifiedAdmin = false;
    if (shouldNotifyAdmin) {
      const lines = [
        'New credits purchase request',
        `User: ${user?.name || user?.username || 'Unknown'}`,
        `Email: ${user?.email || 'Unknown'}`,
        `User ID: ${userId}`,
        `IP: ${ip || 'Unknown'}`,
        `Location: ${[geo.city, geo.country].filter(Boolean).join(', ') || 'Unknown'}`,
        `Continent: ${geo.continentCode || 'Unknown'}`,
        `Current Balance: ${currentBalance == null ? 'Unknown' : currentBalance}`,
        `Requested At (UTC): ${new Date().toISOString()}`,
      ];
      notifiedAdmin = await sendAdminMessage({ text: lines.join('\n') });
    }

    if (record?._id) {
      await ViventiumCreditsRequest.updateOne({ _id: record._id }, { $set: { notifiedAdmin } });
    }

    return res.status(200).json({
      success: true,
      message: "Thank you! We've received your request and will review it shortly.",
    });
  } catch (error) {
    logger.error('[VIVENTIUM][credits] Failed to process credits request', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to submit credits request. Please try again shortly.',
    });
  }
});

module.exports = router;
