/* === VIVENTIUM START ===
 * Feature: Surface-aware prompt helpers (voice, web, telegram, playground)
 *
 * Purpose:
 * - Centralize surface detection and formatting instructions.
 * - Keep main agents and background cortices aligned on output style.
 *
 * Added: 2026-01-15
 * === VIVENTIUM END === */

function resolveViventiumSurface(req) {
  const bodySurface = (req?.body?.viventiumSurface || '').toString().toLowerCase();
  if (bodySurface) {
    return bodySurface;
  }
  const headerSurface = (req?.headers?.['x-viventium-surface'] || '').toString().toLowerCase();
  if (headerSurface) {
    return headerSurface;
  }
  const url = (req?.originalUrl || req?.baseUrl || req?.path || '').toString().toLowerCase();
  if (url.includes('/viventium/telegram')) {
    return 'telegram';
  }
  if (url.includes('/viventium/voice')) {
    return 'voice';
  }
  return '';
}

/* === VIVENTIUM START ===
 * Feature: Cartesia Sonic-3 capability source of truth
 * Purpose: Keep model-facing prompt instructions aligned with runtime TTS
 * validation and with Cartesia's documented Sonic-3 contract.
 * === VIVENTIUM END === */
const CARTESIA_SONIC3_CAPABILITIES = require('../../../../../shared/voice/cartesia_sonic3_capabilities.json');
const CARTESIA_SONIC3_EMOTIONS = CARTESIA_SONIC3_CAPABILITIES.generation_config.emotion.values;
const CARTESIA_SONIC3_PRIMARY_EMOTIONS = CARTESIA_SONIC3_CAPABILITIES.generation_config.emotion.primary;
const CARTESIA_SONIC3_SPEED = CARTESIA_SONIC3_CAPABILITIES.generation_config.speed;
const CARTESIA_SONIC3_VOLUME = CARTESIA_SONIC3_CAPABILITIES.generation_config.volume;
const CARTESIA_SONIC3_NONVERBAL_MARKERS = CARTESIA_SONIC3_CAPABILITIES.nonverbal_markers;
const XAI_TTS_CAPABILITIES = require('../../../../../shared/voice/xai_tts_capabilities.json');
const XAI_TTS_INLINE_TAGS = XAI_TTS_CAPABILITIES.speech_tags.inline;
const XAI_TTS_WRAPPING_TAGS = XAI_TTS_CAPABILITIES.speech_tags.wrapping;
const { getPromptText } = require('./promptRegistry');
/* === VIVENTIUM END === */

function normalizeVoiceProvider(voiceProvider) {
  const provider = (voiceProvider || '').toLowerCase();
  if (['x_ai', 'grok', 'xai_grok_voice'].includes(provider)) {
    return 'xai';
  }
  return provider;
}

function buildVoiceModeInstructions(voiceProvider) {
  const override = (process.env.VIVENTIUM_VOICE_MODE_PROMPT || '').trim();
  if (override) {
    return override;
  }

  const baseRules = [
    'VOICE MODE:',
    '- Respond as spoken audio. Use short sentences. No markdown, lists, or code blocks.',
    '- Do not output planning steps or tool instructions.',
    '- Do not read URLs or email addresses aloud; offer to send details instead.',
    '- Use natural language for dates/times (no raw timestamps).',
    '- Use plain ASCII punctuation for spoken/display text. Do not use Unicode dash punctuation such as U+2013 or U+2014. Use commas, periods, or short sentence breaks instead.',
    '- Keep responses concise (1-4 sentences) unless the user asks for detail.',
    '- Do not add memory/personality context to simple audio checks or short acknowledgments; answer the spoken need first and stop when no extra value is needed.',
    '- If the user talks about voice providers, TTS, fallback routes, markup, or audio internals, treat that as a delivery constraint unless they explicitly ask for diagnostics. Do not narrate provider/fallback mechanics; give only the user-facing spoken response.',
    "- Never claim a voice model/provider/fallback route is down, unavailable, or active from the user's hypothetical wording alone. Only state a delivery outage when verified runtime evidence says so; otherwise answer naturally.",
    '- If the user includes [voice], treat it as a strict voice-mode tag.',
  ];

  const provider = normalizeVoiceProvider(voiceProvider);
  if (provider.includes('chatterbox')) {
    const fallback = [
      ...baseRules,
      // Conservative set only: keep markers that reliably render as nonverbal audio in local MLX tests.
      '- Allowed nonverbal markers (use exactly these tokens): [laugh], [sigh], [gasp].',
      '- Put nonverbal markers on their own line or between sentences (do not embed inside a sentence).',
      '- Do NOT invent other bracketed stage directions.',
      '- Do NOT use <emotion .../> tags (those are Cartesia-only).',
    ].join('\n');
    return getPromptText('surface.voice.provider.chatterbox', fallback);
  }
  if (provider === 'cartesia') {
    const fallback = [
      ...baseRules,
      `- Cartesia ${CARTESIA_SONIC3_CAPABILITIES.model_id} TTS is selected. You may use documented Cartesia SSML-like tags in the assistant text when they improve spoken delivery.`,
      `- Allowed nonverbal marker from Cartesia docs: ${CARTESIA_SONIC3_NONVERBAL_MARKERS.join(', ')}. Use it only when actual laughter belongs in the spoken response.`,
      '- Put nonverbal markers on their own line or between sentences (do not embed inside a sentence).',
      '- Do NOT invent other bracketed stage directions.',
      /* === VIVENTIUM NOTE ===
       * Feature: Cartesia SSML emotion parity (self-closing tags).
       * Purpose: Align the model-facing contract with Cartesia docs and our adapter parsing.
       * Updated 2026-04-28: Sonic-3 shared capability source, full tag coverage, and streaming-safe complete tag guidance.
       */
      '- Optional emotion control (preferred): <emotion value="calm"/> before a sentence to set the tone for subsequent text (until changed).',
      '- Optional wrapper form (also supported): <emotion value="excited">TEXT</emotion> to apply emotion to a specific phrase only.',
      `- Allowed emotion values: ${CARTESIA_SONIC3_EMOTIONS.join(', ')}.`,
      `- Primary/highest-reliability emotion values: ${CARTESIA_SONIC3_PRIMARY_EMOTIONS.join(', ')}.`,
      `- Optional speed/volume control: use <speed ratio="1.1"/> or <volume ratio="0.9"/> before a sentence; speed must be ${CARTESIA_SONIC3_SPEED.min}-${CARTESIA_SONIC3_SPEED.max} and volume must be ${CARTESIA_SONIC3_VOLUME.min}-${CARTESIA_SONIC3_VOLUME.max}.`,
      '- Use <break time="1s"/> for natural pauses between thoughts (supports seconds "1s" or milliseconds "500ms").',
      '- Use <spell>ABC123</spell> only for identifiers, codes, numbers, names, or terms that should be spelled out.',
      '- Write every SSML-like tag as one complete tag with the full attribute value. Do not output partial tags or explain the markup.',
      '- Use emotion, speed, volume, break, spell, and laughter markers sparingly; natural wording still matters more than markup.',
      /* === VIVENTIUM NOTE === */
    ].join('\n');
    return getPromptText('surface.voice.provider.cartesia', fallback, {
      cartesia: {
        model_id: CARTESIA_SONIC3_CAPABILITIES.model_id,
        nonverbal_markers: CARTESIA_SONIC3_NONVERBAL_MARKERS,
        emotions: CARTESIA_SONIC3_EMOTIONS,
        primary_emotions: CARTESIA_SONIC3_PRIMARY_EMOTIONS,
        speed: CARTESIA_SONIC3_SPEED,
        volume: CARTESIA_SONIC3_VOLUME,
      },
    });
  }

  /* === VIVENTIUM NOTE ===
   * Feature: xAI standalone TTS prompt guard.
   * Purpose: xAI TTS has its own speech-tag dialect. Keep it separate from
   * Cartesia Sonic-3 SSML-like tags and from the older Grok Voice Agent prompt.
   */
  if (provider === 'xai') {
    const fallback = [
      ...baseRules,
      '- xAI TTS is selected. You may use only documented xAI speech tags when they improve spoken delivery.',
      `- Allowed xAI inline tags: ${XAI_TTS_INLINE_TAGS.join(', ')}.`,
      `- Allowed xAI wrapping tags: ${XAI_TTS_WRAPPING_TAGS.map((tag) => `<${tag}>TEXT</${tag}>`).join(', ')}.`,
      '- Use wrapping tags only on short phrases, include the closing tag, and do not split tag names across streamed chunks.',
      '- Do NOT invent other bracketed stage directions or XML tags.',
      '- Do NOT use Cartesia-only controls: <emotion>, <speed>, <volume>, <break>, <spell>, or [laughter].',
      '- xAI TTS has no Cartesia-style emotion parameter; express tone through natural wording plus the documented xAI speech tags.',
      '- Use xAI speech tags sparingly; natural wording still matters more than markup.',
    ].join('\n');
    return getPromptText('surface.voice.provider.xai', fallback, {
      xai: {
        inline_tags: XAI_TTS_INLINE_TAGS,
        wrapping_tags: XAI_TTS_WRAPPING_TAGS.map((tag) => `<${tag}>TEXT</${tag}>`),
      },
    });
  }
  /* === VIVENTIUM NOTE === */

  /* === VIVENTIUM NOTE ===
   * Feature: Non-Cartesia prompt guard (ElevenLabs, OpenAI).
   * Purpose: After TTS fallback, prevent LLM from continuing to emit
   * Cartesia-specific SSML/stage markers that would be spoken literally
   * by providers that do not support them.
   */
  if (provider === 'openai' || provider === 'elevenlabs') {
    const fallback = [
      ...baseRules,
      '- Do NOT use <emotion .../> or any XML/SSML-like tags.',
      '- Do NOT use bracketed stage directions like [laugh], [laughter], or [sigh].',
      '- Express tone and emotion through natural word choice and sentence structure only.',
      '- Do not mention fallback, provider, route, or TTS mechanics in the spoken response unless the user explicitly asks for diagnostics.',
    ].join('\n');
    return getPromptText('surface.voice.provider.plain_tts', fallback);
  }
  /* === VIVENTIUM NOTE === */

  return getPromptText('surface.voice.call', baseRules.join('\n'));
}

function buildTelegramTextInstructions() {
  const override = (process.env.VIVENTIUM_TELEGRAM_TEXT_MODE_PROMPT || '').trim();
  if (override) {
    return override;
  }
  const fallback = [
    'TELEGRAM TEXT MODE:',
    '- Use standard Markdown formatting (bold, italic, inline code, code blocks, block quotes).',
    '- Do NOT use Telegram MarkdownV2 escaping (no backslash-escaped punctuation like \\. \\- \\!).',
    '- Avoid markdown tables, heading syntax (#), and HTML.',
    '- Use short bold section titles and bullet lists; keep paragraphs short.',
    '- If sources are helpful, include plain URLs on a "Sources" line (no markdown links, no citation markers).',
  ].join('\n');
  return getPromptText('surface.telegram.text', fallback);
}

function buildWebTextInstructions() {
  const override = (process.env.VIVENTIUM_WEB_TEXT_MODE_PROMPT || '').trim();
  if (override) {
    return override;
  }
  const fallback = [
    'WEB TEXT MODE:',
    '- Use standard Markdown formatting (bold, italic, inline code, code blocks, block quotes).',
    '- Prefer short paragraphs and bullet lists when they improve scanability.',
    '- Avoid markdown tables, heading syntax (#), and HTML.',
    '- If sources are helpful, include plain URLs on a "Sources" line (no markdown links, no citation markers).',
  ].join('\n');
  return getPromptText('surface.web', fallback);
}

function buildPlaygroundTextInstructions() {
  const override = (process.env.VIVENTIUM_PLAYGROUND_TEXT_MODE_PROMPT || '').trim();
  if (override) {
    return override;
  }
  const fallback = [
    'PLAYGROUND TEXT MODE:',
    '- Respond conversationally in plain text.',
    '- Avoid markdown formatting, lists, tables, and citation markers.',
  ].join('\n');
  return getPromptText('surface.playground', fallback);
}

function buildVoiceNoteInputInstructions() {
  const override = (process.env.VIVENTIUM_TELEGRAM_VOICE_NOTE_PROMPT || '').trim();
  if (override) {
    return override;
  }
  const fallback = [
    'INPUT MODE: TELEGRAM VOICE NOTE TRANSCRIPTION',
    '- The user spoke this request; transcription may contain minor errors.',
    '- Ask a clarifying question if the wording seems ambiguous.',
  ].join('\n');
  return getPromptText('surface.telegram.voice_note', fallback);
}

function buildVoiceCallInputInstructions() {
  const override = (process.env.VIVENTIUM_VOICE_CALL_INPUT_PROMPT || '').trim();
  if (override) {
    return override;
  }
  const fallback = [
    'INPUT MODE: LIVE VOICE CALL',
    '- The user is speaking in real time; prioritize quick, spoken responses.',
    '- Avoid long lists, URLs, and email addresses; offer to send details via text.',
  ].join('\n');
  return getPromptText('surface.voice.call_input', fallback);
}

function buildWingModeInstructions() {
  const override =
    (process.env.VIVENTIUM_WING_MODE_PROMPT || '').trim() ||
    (process.env.VIVENTIUM_SHADOW_MODE_PROMPT || '').trim();
  if (override) {
    return override;
  }
  const fallback = [
    'WING MODE:',
    '- You are in Wing Mode during a live voice call: quietly aware, helpful, and unobtrusive.',
    '- Treat TV, podcasts, videos, songs, meetings, and nearby chatter as background context unless the user is clearly talking to you.',
    '- A live call does not mean every spoken sentence is addressed to you; a bare spoken question, comment, or thought in the room is background unless the user directly addresses you or it clearly requires your memory, tools, or role in the call.',
    '- Silence is the default outcome. Speak only when the user directly addresses you, asks you to act, or there is a clear time-sensitive/safety-critical intervention.',
    '- Do not respond with emotional support, reflection, or "space to talk" just because ambient speech sounds personal, tired, stressed, or vulnerable.',
    '- If you do not have a clear, useful, additive contribution, output exactly {NTA}.',
    '- If you are not sure the user is addressing you, output exactly {NTA}.',
    '- Err aggressively on the side of silence.',
  ].join('\n');
  return getPromptText('surface.wing', fallback);
}

function isWingModeEnabledForRequest(req, inputMode) {
  if ((inputMode || '').toString().toLowerCase() !== 'voice_call') {
    return false;
  }

  const session = req?.viventiumCallSession;
  if (!session || typeof session !== 'object') {
    return false;
  }
  if (typeof session.wingModeEnabled === 'boolean') {
    return session.wingModeEnabled;
  }
  if (typeof session.shadowModeEnabled === 'boolean') {
    return session.shadowModeEnabled;
  }
  return false;
}

function buildCortexOutputInstructions({ voiceMode, surface, inputMode }) {
  const override = (process.env.VIVENTIUM_CORTEX_OUTPUT_RULES || '').trim();
  if (override) {
    return override;
  }

  const voiceInput =
    voiceMode === true ||
    surface === 'voice' ||
    inputMode === 'voice_note' ||
    inputMode === 'voice_call';

  const lines = [
    'CORTEX OUTPUT RULES:',
    '- Provide only a concise, user-facing summary of the results.',
    '- Do NOT include internal plans, tool instructions, or API field names.',
    '- Do NOT claim a tool, worker, browser, email, file, or OS action happened unless this cortex actually received a verified tool result for that action in this run.',
    '- If the main agent is already handling a direct tool/worker execution and you do not have independent verified results, output exactly {NTA}.',
    '- Never fabricate tool-call transcripts, run ids, worker ids, or dispatch confirmations.',
    '- Do NOT include citation markers.',
  ];

  if (voiceInput) {
    lines.push(
      '- Output plain conversational text (no markdown, no lists, no tables).',
      '- Do not read URLs or email addresses aloud; offer to send details.',
      '- Use natural language for dates/times (no raw timestamps).',
      '- Keep it to 1-3 short sentences unless the user asked for more detail.',
      /* === VIVENTIUM NOTE ===
       * Feature: Prevent cortex outputs from containing TTS-specific markup.
       * Purpose: Cortex outputs feed into follow-up voice speech. Tags would be spoken literally
       * by non-Cartesia providers or appear raw in persisted messages.
       * Added: 2026-02-22
       */
      '- Do NOT use emotion tags, SSML tags, or bracketed stage directions (e.g., [laughter]).',
      /* === VIVENTIUM NOTE END === */
    );
  } else if (surface === 'telegram') {
    lines.push(
      '- Use standard Markdown formatting; avoid tables, heading syntax (#), and MarkdownV2 backslash escaping.',
      '- Keep paragraphs short and use simple bullet lists when helpful.',
    );
  } else if (surface === 'playground') {
    lines.push('- Output plain conversational text (no markdown, no lists, no tables).');
  } else {
    lines.push(
      '- Use standard Markdown formatting; prefer short paragraphs and bullet lists when they improve clarity.',
      '- Avoid markdown tables, heading syntax (#), and HTML.',
    );
  }

  let promptId = 'surface.cortex_output.web';
  if (voiceInput) {
    promptId = 'surface.cortex_output.voice';
  } else if (surface === 'telegram') {
    promptId = 'surface.cortex_output.telegram';
  } else if (surface === 'playground') {
    promptId = 'surface.cortex_output.playground';
  }
  return getPromptText(promptId, lines.join('\n'));
}

/* === VIVENTIUM NOTE ===
 * Feature: Timezone validation helpers for time context injection
 *
 * Purpose:
 * - Prevent invalid timezones from silently producing UTC output.
 * - Normalize and validate client-provided timezones before formatting.
 * - Ensure the label matches the actual timezone used.
 *
 * Added: 2026-02-01
 * === VIVENTIUM NOTE === */
const TIMEZONE_VALIDATION_CACHE = new Map();

function normalizeTimezone(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isValidTimezone(timezone) {
  const normalized = normalizeTimezone(timezone);
  if (!normalized) {
    return false;
  }
  const isIanaLike =
    normalized.includes('/') ||
    normalized === 'UTC' ||
    normalized === 'GMT' ||
    normalized.startsWith('UTC') ||
    normalized.startsWith('GMT') ||
    normalized.startsWith('Etc/');
  if (!isIanaLike) {
    TIMEZONE_VALIDATION_CACHE.set(normalized, false);
    return false;
  }
  if (TIMEZONE_VALIDATION_CACHE.has(normalized)) {
    return TIMEZONE_VALIDATION_CACHE.get(normalized);
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    TIMEZONE_VALIDATION_CACHE.set(normalized, true);
    return true;
  } catch (_err) {
    TIMEZONE_VALIDATION_CACHE.set(normalized, false);
    return false;
  }
}

function resolveTimeContextTimezone({ clientTimezone, defaultTimezone }) {
  const normalizedClient = normalizeTimezone(clientTimezone);
  const normalizedDefault = normalizeTimezone(defaultTimezone);

  if (normalizedClient && isValidTimezone(normalizedClient)) {
    return normalizedClient;
  }
  if (normalizedDefault && isValidTimezone(normalizedDefault)) {
    return normalizedDefault;
  }
  return 'UTC';
}

/* === VIVENTIUM START ===
 * Feature: Timezone-safe parsing for naive client timestamps
 *
 * Purpose:
 * - Interpret naive timestamps (no offset) as wall-clock time in the resolved client timezone.
 * - Remove dependency on container/server TZ when building "Current time: ...".
 * - Keep explicit ISO timestamps with offsets/Z behavior unchanged.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const NAIVE_TIMESTAMP_REGEX = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const TIMEZONE_PARTS_FORMATTER_CACHE = new Map();

function hasExplicitTimezone(timestamp) {
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(timestamp);
}

function parseNaiveTimestamp(timestamp) {
  const match = timestamp.match(NAIVE_TIMESTAMP_REGEX);
  if (!match) {
    return null;
  }

  const millisecondSource = match[7] ? match[7].padEnd(3, '0') : '0';
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || '0'),
    millisecond: Number(millisecondSource),
  };
}

function getTimeZonePartsFormatter(timeZone) {
  if (TIMEZONE_PARTS_FORMATTER_CACHE.has(timeZone)) {
    return TIMEZONE_PARTS_FORMATTER_CACHE.get(timeZone);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  TIMEZONE_PARTS_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function extractTimeZoneParts(dateObj, timeZone) {
  const formatter = getTimeZonePartsFormatter(timeZone);
  const tokens = formatter.formatToParts(dateObj);
  const values = {};

  for (const token of tokens) {
    if (
      token.type === 'year' ||
      token.type === 'month' ||
      token.type === 'day' ||
      token.type === 'hour' ||
      token.type === 'minute' ||
      token.type === 'second'
    ) {
      values[token.type] = Number(token.value);
    }
  }

  if (
    !Number.isFinite(values.year) ||
    !Number.isFinite(values.month) ||
    !Number.isFinite(values.day) ||
    !Number.isFinite(values.hour) ||
    !Number.isFinite(values.minute) ||
    !Number.isFinite(values.second)
  ) {
    return null;
  }

  return values;
}

function getTimezoneOffsetMinutesAtInstant(dateObj, timeZone) {
  const parts = extractTimeZoneParts(dateObj, timeZone);
  if (!parts) {
    return null;
  }

  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtcMs - dateObj.getTime()) / 60000);
}

function resolveNaiveTimestampToDate(parts, timeZone) {
  if (!parts || !isValidTimezone(timeZone)) {
    return null;
  }

  const baseUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  let candidateMs = baseUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = getTimezoneOffsetMinutesAtInstant(new Date(candidateMs), timeZone);
    if (!Number.isFinite(offsetMinutes)) {
      return null;
    }

    const nextCandidateMs = baseUtcMs - offsetMinutes * 60 * 1000;
    if (nextCandidateMs === candidateMs) {
      break;
    }
    candidateMs = nextCandidateMs;
  }

  const resolved = new Date(candidateMs);
  return Number.isNaN(resolved.getTime()) ? null : resolved;
}

function parseClientTimestamp(clientTimestamp, timeZone) {
  if (typeof clientTimestamp !== 'string') {
    return null;
  }

  const normalized = clientTimestamp.trim();
  if (!normalized) {
    return null;
  }

  if (hasExplicitTimezone(normalized)) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const naiveParts = parseNaiveTimestamp(normalized);
  if (naiveParts) {
    return resolveNaiveTimestampToDate(naiveParts, timeZone);
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* === VIVENTIUM NOTE ===
 * Feature: Time context injection for scheduling awareness
 *
 * Purpose:
 * - Provide LLM with user's current local time for scheduling tasks.
 * - Uses clientTimestamp + clientTimezone from request if available.
 * - Falls back to server time + default timezone.
 * - Ensures invalid timezones do not silently force UTC while keeping a stale label.
 *
 * Added: 2026-01-31
 * Updated: 2026-02-01
 * === VIVENTIUM NOTE === */
function buildTimeContextInstructions(req) {
  const override = (process.env.VIVENTIUM_TIME_CONTEXT_PROMPT || '').trim();
  if (override) {
    return override;
  }

  // Skip if explicitly disabled
  if (process.env.VIVENTIUM_TIME_CONTEXT_DISABLED === '1') {
    return '';
  }

  const body = req?.body || {};
  const clientTimestamp = body.clientTimestamp;
  const resolvedTimezone = resolveTimeContextTimezone({
    clientTimezone: body.clientTimezone,
    defaultTimezone: process.env.VIVENTIUM_DEFAULT_TIMEZONE,
  });

  const dateObj = parseClientTimestamp(clientTimestamp, resolvedTimezone) || new Date();

  // Format in user's timezone with human-readable output
  let formatted;
  try {
    formatted = dateObj.toLocaleString('en-US', {
      timeZone: resolvedTimezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch (_err) {
    // Invalid timezone - fall back to UTC
    formatted = dateObj.toLocaleString('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  return getPromptText('surface.time_context', `Current time: ${formatted} (${resolvedTimezone})`, {
    formatted_time: formatted,
    timezone: resolvedTimezone,
  });
}

/* === VIVENTIUM START ===
 * Feature: Strip voice control tags for display/persistence.
 * Purpose: Remove Cartesia SSML, bracket nonverbal markers, and other TTS-specific
 * markup from text before it is displayed in the UI or persisted to the database.
 * This prevents raw tags like <emotion value="excited"/> and [laughter] from appearing
 * in conversation transcripts.
 * Added: 2026-02-22
 * === VIVENTIUM END === */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const _DISPLAY_EMOTION_SELF_CLOSING_RE = /<emotion\s+value=["']?[^"'>]+["']?\s*\/>/gi;
const _DISPLAY_EMOTION_WRAPPER_RE = /<emotion\s+value=["']?[^"'>]+["']?\s*>(.*?)<\/emotion>/gis;
const _DISPLAY_SPEAK_RE = /<\/?speak[^>]*>/gi;
const _DISPLAY_BREAK_RE = /<break\s+time=["']?[^"'>]+["']?\s*\/>/gi;
const _DISPLAY_SPEED_RE = /<speed\s+ratio=["']?[^"'>]+["']?\s*\/>/gi;
const _DISPLAY_VOLUME_RE = /<volume\s+ratio=["']?[^"'>]+["']?\s*\/>/gi;
const _DISPLAY_SPELL_RE = /<spell>(.*?)<\/spell>/gis;
const _DISPLAY_XAI_WRAPPER_RE = new RegExp(
  `<(${XAI_TTS_WRAPPING_TAGS.map(escapeRegex).join('|')})>(.*?)</\\1>`,
  'gis',
);
const _DISPLAY_XAI_TAG_NAME_PATTERN = XAI_TTS_WRAPPING_TAGS.map(escapeRegex).join('|');
const _DISPLAY_XAI_ANGLE_TAG_RE = new RegExp(`</?(?:${_DISPLAY_XAI_TAG_NAME_PATTERN})\\s*>`, 'gi');
const _DISPLAY_XAI_BRACKET_TAG_RE = new RegExp(
  `\\[\\s*/?\\s*(?:${_DISPLAY_XAI_TAG_NAME_PATTERN})\\s*\\]`,
  'gi',
);
const _DISPLAY_STAGE_DIRECTION_MIN_ALPHA = 3;
const _DISPLAY_STAGE_DIRECTION_MAX_ALPHA = 24;
const _DISPLAY_STAGE_DIRECTION_MAX_WORDS = 3;

function isDisplayStageDirectionBoundary(ch) {
  return !ch || /\s/.test(ch) || '.,!?;:(){}<>"\''.includes(ch);
}

function isBracketStageDirection(content) {
  const candidate = typeof content === 'string' ? content.trim() : '';
  if (!candidate || candidate !== candidate.toLowerCase()) {
    return false;
  }
  if (/\d/.test(candidate)) {
    return false;
  }
  if (!/^[a-z' -]+$/.test(candidate)) {
    return false;
  }

  const alphaCount = (candidate.match(/[a-z]/g) || []).length;
  if (
    alphaCount < _DISPLAY_STAGE_DIRECTION_MIN_ALPHA ||
    alphaCount > _DISPLAY_STAGE_DIRECTION_MAX_ALPHA
  ) {
    return false;
  }

  const words = candidate
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > _DISPLAY_STAGE_DIRECTION_MAX_WORDS) {
    return false;
  }
  return words.every((word) => /^[a-z']+$/.test(word));
}

function stripBracketStageDirections(text) {
  if (!text) {
    return '';
  }

  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '[') {
      out += text[index];
      index += 1;
      continue;
    }

    const closing = text.indexOf(']', index + 1);
    if (closing < 0) {
      out += text[index];
      index += 1;
      continue;
    }

    const content = text.slice(index + 1, closing);
    const left = index > 0 ? text[index - 1] : '';
    const right = closing + 1 < text.length ? text[closing + 1] : '';
    if (isBracketStageDirection(content) && isDisplayStageDirectionBoundary(left) && isDisplayStageDirectionBoundary(right)) {
      index = closing + 1;
      continue;
    }

    out += text.slice(index, closing + 1);
    index = closing + 1;
  }

  return out;
}

function stripXaiWrappingTags(text) {
  let cleaned = text || '';
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(_DISPLAY_XAI_WRAPPER_RE, '$2');
  } while (cleaned !== previous);
  cleaned = cleaned.replace(_DISPLAY_XAI_ANGLE_TAG_RE, '');
  cleaned = cleaned.replace(_DISPLAY_XAI_BRACKET_TAG_RE, '');
  return cleaned;
}

function stripVoiceControlTagsForDisplay(text) {
  if (!text) {
    return '';
  }
  let cleaned = text;
  cleaned = cleaned.replace(_DISPLAY_SPEAK_RE, '');
  cleaned = cleaned.replace(_DISPLAY_EMOTION_SELF_CLOSING_RE, '');
  cleaned = cleaned.replace(_DISPLAY_EMOTION_WRAPPER_RE, '$1');
  cleaned = cleaned.replace(_DISPLAY_BREAK_RE, '');
  cleaned = cleaned.replace(_DISPLAY_SPEED_RE, '');
  cleaned = cleaned.replace(_DISPLAY_VOLUME_RE, '');
  cleaned = cleaned.replace(_DISPLAY_SPELL_RE, '$1');
  cleaned = stripXaiWrappingTags(cleaned);
  cleaned = stripBracketStageDirections(cleaned);
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  return cleaned.trim();
}

module.exports = {
  resolveViventiumSurface,
  buildVoiceModeInstructions,
  buildTelegramTextInstructions,
  buildWebTextInstructions,
  buildPlaygroundTextInstructions,
  buildVoiceNoteInputInstructions,
  buildVoiceCallInputInstructions,
  buildWingModeInstructions,
  isWingModeEnabledForRequest,
  buildCortexOutputInstructions,
  buildTimeContextInstructions,
  stripVoiceControlTagsForDisplay,
};
