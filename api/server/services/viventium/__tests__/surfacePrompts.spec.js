/* === VIVENTIUM START ===
 * Feature: Time context injection timezone resolution tests
 *
 * Purpose:
 * - Validate client timezone usage and fallback behavior.
 * - Ensure labels match the resolved timezone.
 *
 * Added: 2026-02-01
 * === VIVENTIUM END === */

const {
  buildTimeContextInstructions,
  buildVoiceModeInstructions,
  buildWingModeInstructions,
  isWingModeEnabledForRequest,
  buildTelegramAudioOutputInstructions,
  buildTelegramTextInstructions,
  buildWebTextInstructions,
  buildCortexOutputInstructions,
  stripVoiceControlTagsForDisplay,
  sanitizeVoiceSurfaceTextForDisplay,
  FEELING_AWARE_VOICE_EXPRESSION_RULES,
} = require('../surfacePrompts');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetPromptRegistryForTests } = require('../promptRegistry');

const CARTESIA_SONIC3_CAPABILITIES = require('../../../../../shared/voice/cartesia_sonic3_capabilities.json');
const XAI_TTS_CAPABILITIES = require('../../../../../shared/voice/xai_tts_capabilities.json');
const TTS_PROVIDER_CAPABILITIES = require('../../../../../shared/voice/tts_provider_capabilities.json');

describe('buildTimeContextInstructions', () => {
  const originalDefaultTimezone = process.env.VIVENTIUM_DEFAULT_TIMEZONE;
  const originalDisableFlag = process.env.VIVENTIUM_TIME_CONTEXT_DISABLED;
  const originalPromptOverride = process.env.VIVENTIUM_TIME_CONTEXT_PROMPT;

  afterEach(() => {
    if (originalDefaultTimezone === undefined) {
      delete process.env.VIVENTIUM_DEFAULT_TIMEZONE;
    } else {
      process.env.VIVENTIUM_DEFAULT_TIMEZONE = originalDefaultTimezone;
    }
    if (originalDisableFlag === undefined) {
      delete process.env.VIVENTIUM_TIME_CONTEXT_DISABLED;
    } else {
      process.env.VIVENTIUM_TIME_CONTEXT_DISABLED = originalDisableFlag;
    }
    if (originalPromptOverride === undefined) {
      delete process.env.VIVENTIUM_TIME_CONTEXT_PROMPT;
    } else {
      process.env.VIVENTIUM_TIME_CONTEXT_PROMPT = originalPromptOverride;
    }
  });

  test('uses clientTimezone when valid', () => {
    const req = {
      body: {
        clientTimestamp: '2026-02-01T21:09:00Z',
        clientTimezone: 'America/Toronto',
      },
    };
    const result = buildTimeContextInstructions(req);
    expect(result).toContain('America/Toronto');
    expect(result).toMatch(/4:09 PM/);
  });

  test('interprets naive local timestamp using client timezone (TZ-safe)', () => {
    const req = {
      body: {
        clientTimestamp: '2026-02-19T15:02:30',
        clientTimezone: 'America/Toronto',
      },
    };
    const result = buildTimeContextInstructions(req);
    expect(result).toContain('America/Toronto');
    expect(result).toMatch(/3:02 PM/);
  });

  test('keeps explicit offset timestamps unchanged', () => {
    const req = {
      body: {
        clientTimestamp: '2026-02-19T15:02:30-05:00',
        clientTimezone: 'America/Toronto',
      },
    };
    const result = buildTimeContextInstructions(req);
    expect(result).toContain('America/Toronto');
    expect(result).toMatch(/3:02 PM/);
  });

  test('falls back to env default when clientTimezone is invalid', () => {
    process.env.VIVENTIUM_DEFAULT_TIMEZONE = 'America/Toronto';
    const req = {
      body: {
        clientTimestamp: '2026-02-01T21:09:00Z',
        clientTimezone: 'EST',
      },
    };
    const result = buildTimeContextInstructions(req);
    expect(result).toContain('America/Toronto');
    expect(result).toMatch(/4:09 PM/);
  });

  test('falls back to UTC when no valid timezone is available', () => {
    delete process.env.VIVENTIUM_DEFAULT_TIMEZONE;
    const req = {
      body: {
        clientTimestamp: '2026-02-01T21:09:00Z',
        clientTimezone: 'Not/AZone',
      },
    };
    const result = buildTimeContextInstructions(req);
    expect(result).toContain('(UTC)');
    expect(result).toMatch(/9:09 PM/);
  });

  test('appends deterministic scheduler run context when provided', () => {
    const req = {
      body: {
        clientTimestamp: '2026-06-15T15:00:26Z',
        clientTimezone: 'America/Los_Angeles',
        scheduledDueAt: '2026-06-15T15:00:00Z',
        schedulerRunContext: {
          run_started_at_utc: '2026-06-15T15:00:26Z',
          scheduled_due_at_utc: '2026-06-15T15:00:00Z',
          scheduled_due_local: '2026-06-15T08:00:00-07:00',
          scheduled_due_local_date: 'Monday, June 15, 2026',
          scheduled_due_local_date_iso: '2026-06-15',
          schedule_timezone: 'America/Los_Angeles',
          current_schedule_local_time: '2026-06-15T08:00:26-07:00',
          calendar_window_local_start: '2026-06-15T00:00:00-07:00',
          calendar_window_local_end_exclusive: '2026-06-16T00:00:00-07:00',
          calendar_window_utc_start: '2026-06-15T07:00:00Z',
          calendar_window_utc_end_exclusive: '2026-06-16T07:00:00Z',
        },
      },
    };

    const result = buildTimeContextInstructions(req);

    expect(result).toContain('Current time: Monday, June 15, 2026');
    expect(result).toContain('Scheduled run context:');
    expect(result).toContain('Anchor date for this scheduled run: Monday, June 15, 2026');
    expect(result).toContain('Anchor date tag: scheduled_due_local_date_iso=2026-06-15');
    expect(result).toContain('Calendar window UTC: 2026-06-15T07:00:00Z to 2026-06-16T07:00:00Z');
    expect(result).toContain('Do not infer the day from prior scheduled briefings');
    expect(result).toContain(
      'Calendar, email, task, and current-day claims require verified tool/cortex evidence',
    );
  });
});

/* === VIVENTIUM START ===
 * Feature: Voice-mode instruction provider branch tests
 * Purpose: Verify that buildVoiceModeInstructions returns correct rules
 * for Cartesia, Chatterbox, OpenAI, ElevenLabs, and generic providers.
 * Added: 2026-02-14
 * === VIVENTIUM END === */
describe('buildVoiceModeInstructions', () => {
  const originalOverride = process.env.VIVENTIUM_VOICE_MODE_PROMPT;
  const originalPromptBundlePath = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.VIVENTIUM_VOICE_MODE_PROMPT;
    } else {
      process.env.VIVENTIUM_VOICE_MODE_PROMPT = originalOverride;
    }
    if (originalPromptBundlePath === undefined) {
      delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    } else {
      process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = originalPromptBundlePath;
    }
    resetPromptRegistryForTests();
  });

  test('cartesia branch includes emotion tag guidance', () => {
    const result = buildVoiceModeInstructions('cartesia');
    expect(result).toContain('VOICE MODE:');
    expect(result).toContain('[laughter]');
    expect(result).not.toContain('[sigh]');
    expect(result).toContain('<emotion value=');
    expect(result).toContain('nonverbal markers');
  });

  test('chatterbox branch allows bracket markers and prohibits emotion tags', () => {
    const result = buildVoiceModeInstructions('local_chatterbox_turbo_mlx_8bit');
    expect(result).toContain('VOICE MODE:');
    for (const marker of TTS_PROVIDER_CAPABILITIES.providers.local_chatterbox_turbo_mlx_8bit
      .inline_controls.exact_tokens) {
      expect(result).toContain(marker);
    }
    expect(result).toContain(
      'When delivery is expressive under the feeling-expression contract, include one allowed marker only when that marker naturally fits; when none fits or delivery is restrained, include none.',
    );
    expect(result).toContain('Do NOT use <emotion');
  });

  test('provider capability contract distinguishes inline controls from side channels', () => {
    const providers = TTS_PROVIDER_CAPABILITIES.providers;
    expect(Object.keys(providers).sort()).toEqual(
      ['cartesia', 'elevenlabs', 'local_chatterbox_turbo_mlx_8bit', 'openai', 'xai'].sort(),
    );
    expect(providers.openai.inline_controls).toMatchObject({
      supported: false,
      mode: 'plain_text_only',
      exact_tokens: [],
    });
    expect(
      providers.openai.runtime_models.find((model) => model.id === 'gpt-4o-mini-tts').side_channels
        .instructions,
    ).toBe(true);
    expect(providers.openai.dynamic_expression.per_turn_wired).toBe(false);
    expect(providers.elevenlabs.default_model).toBe('eleven_turbo_v2_5');
    expect(providers.elevenlabs.inline_controls.supported).toBe(false);
    expect(providers.elevenlabs.model_specific_controls_not_enabled).toHaveProperty('eleven_v3');
    expect(providers.cartesia.inline_controls.dialect_contract).toBe(
      'cartesia_sonic3_capabilities.json',
    );
    expect(providers.xai.inline_controls.dialect_contract).toBe('xai_tts_capabilities.json');
    expect(providers.xai.runtime_models).toEqual([
      { id: 'xai-tts', api_route: 'tts', legacy: false },
    ]);
  });

  test('openai branch prohibits all tags', () => {
    const result = buildVoiceModeInstructions('openai');
    expect(result).toContain('VOICE MODE:');
    expect(result).toContain('Do NOT use <emotion');
    expect(result).toContain('Do NOT use bracketed stage directions');
    // Should NOT have an "Allowed nonverbal markers" line (that's Cartesia-only).
    expect(result).not.toContain('Allowed nonverbal markers');
  });

  test('elevenlabs branch prohibits all tags', () => {
    const result = buildVoiceModeInstructions('elevenlabs');
    expect(result).toContain('VOICE MODE:');
    expect(result).toContain('Do NOT use <emotion');
    expect(result).toContain('Do NOT use bracketed stage directions');
    expect(result).not.toContain('Allowed nonverbal markers');
  });

  // === VIVENTIUM START ===
  // Feature: xAI provider branch test (added 2026-02-22)
  test('xai branch includes complete standalone TTS speech tag contract', () => {
    const result = buildVoiceModeInstructions('xai');
    expect(result).toContain('VOICE MODE:');
    expect(result).toContain('xAI TTS is selected');
    for (const tag of XAI_TTS_CAPABILITIES.speech_tags.inline) {
      expect(result).toContain(tag);
    }
    for (const tag of XAI_TTS_CAPABILITIES.speech_tags.wrapping) {
      expect(result).toContain(`<${tag}>TEXT</${tag}>`);
    }
    expect(result).toContain('Wrapping controls require angle brackets');
    expect(result).toContain('[tag]TEXT[/tag] is invalid');
    expect(result).toContain('no Cartesia-style emotion parameter');
    expect(result).toContain('Do NOT use Cartesia-only controls');
  });

  test('xai aliases use the xai standalone TTS prompt branch', () => {
    const result = buildVoiceModeInstructions('x_ai');
    expect(result).toContain('xAI TTS is selected');
    expect(result).toContain('[long-pause]');
  });
  // === VIVENTIUM END ===

  test.each(['cartesia', 'xai', 'local_chatterbox_turbo_mlx_8bit', 'openai', 'unknown'])(
    '%s lets an injected feeling state shape spoken delivery without forcing a performance',
    (provider) => {
      const result = buildVoiceModeInstructions(provider);
      expect(result).toContain('If a <viventium_feeling_state> is present');
      expect(result).toContain(
        'silently appraise whether the current state and moment call for expressive or restrained delivery',
      );
      expect(result).toContain(
        'A strongly outward state in an emotionally meaningful or relational reply is expressive',
      );
      expect(result).toContain(
        'the raw voice-capable response is incomplete unless it contains a fitting documented control',
      );
      expect(result).toContain('Natural wording alone does not satisfy expressive spoken delivery');
      expect(result).toContain('Do not add voice controls merely to prove that a feeling exists');
      expect(result).toContain('private cause');
    },
  );

  test('inline feeling-expression fallback exactly matches the registered prompt source', () => {
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../../viventium/source_of_truth/prompts/surface/voice_feeling_expression.md',
      ),
      'utf8',
    );
    const registeredBody = source.replace(/^---[\s\S]*?\n---\s*\n/, '').trim();
    expect(FEELING_AWARE_VOICE_EXPRESSION_RULES.join('\n')).toBe(registeredBody);
  });

  test('generic fallback returns base rules only', () => {
    const result = buildVoiceModeInstructions('some_unknown_provider');
    expect(result).toContain('VOICE MODE:');
    expect(result).toContain('outputting exactly {NTA}');
    // Generic has no tag-specific guidance at all.
    expect(result).not.toContain('<emotion');
    expect(result).not.toContain('[laughter]');
    expect(result).not.toContain('[laugh]');
  });

  test('compiled voice prompt bundle carries cut-off {NTA} rule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-voice-prompt-bundle-'));
    const bundlePath = path.join(dir, 'prompt-bundle.json');
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({
        prompt_count: 2,
        prompts: {
          'surface.voice.call': {
            metadata: {},
            body: [
              'VOICE MODE:',
              '- If a spoken turn clearly sounds unfinished, cut off, or like the user is still gathering the thought, stay silent by outputting exactly {NTA} instead of answering an assumed intent.',
            ].join('\n'),
          },
          'surface.voice.provider.cartesia': {
            metadata: { includes: ['surface.voice.call'] },
            body: 'Cartesia provider rules.',
          },
        },
      }),
      'utf8',
    );
    process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = bundlePath;
    resetPromptRegistryForTests();

    const result = buildVoiceModeInstructions('cartesia');

    expect(result).toContain('outputting exactly {NTA}');
    expect(result).toContain('Cartesia provider rules.');
  });

  test('override env replaces all rules', () => {
    process.env.VIVENTIUM_VOICE_MODE_PROMPT = 'Custom voice prompt override.';
    const result = buildVoiceModeInstructions('cartesia');
    expect(result).toBe('Custom voice prompt override.');
    expect(result).not.toContain('VOICE MODE:');
  });

  // === VIVENTIUM START ===
  // Feature: Cartesia emotion list and break tag tests (added 2026-02-22)
  test('cartesia branch includes complete Sonic-3 emotion list', () => {
    const result = buildVoiceModeInstructions('cartesia');
    expect(result).toContain('Allowed emotion values');
    for (const emotion of CARTESIA_SONIC3_CAPABILITIES.generation_config.emotion.values) {
      expect(result).toContain(emotion);
    }
  });

  test('cartesia branch includes speed and volume tag guidance', () => {
    const result = buildVoiceModeInstructions('cartesia');
    expect(result).toContain('<speed ratio=');
    expect(result).toContain('<volume ratio=');
    expect(result).toContain('complete tag');
  });

  test('cartesia guidance is rendered from neutral capability syntax rather than fixed emotions', () => {
    const result = buildVoiceModeInstructions('cartesia');
    const tags = CARTESIA_SONIC3_CAPABILITIES.ssml_tags;

    expect(tags.emotion.forms).toEqual([
      '<emotion value="EMOTION"/>',
      '<emotion value="EMOTION">TEXT</emotion>',
    ]);
    expect(tags.speed.form).toBe('<speed ratio="RATIO"/>');
    expect(tags.volume.form).toBe('<volume ratio="RATIO"/>');
    expect(tags.break.form).toBe('<break time="DURATION"/>');
    expect(tags.spell.form).toBe('<spell>TEXT</spell>');

    for (const form of [
      ...tags.emotion.forms,
      tags.speed.form,
      tags.volume.form,
      tags.break.form,
      tags.spell.form,
    ]) {
      expect(result).toContain(form);
    }
    expect(result).not.toContain('<emotion value="calm"/>');
    expect(result).not.toContain('<emotion value="excited">TEXT</emotion>');
    expect(result).not.toContain('<speed ratio="1.1"/>');
    expect(result).not.toContain('<volume ratio="0.9"/>');
    expect(result).not.toContain('<break time="1s"/>');
    expect(result).not.toContain('<spell>ABC123</spell>');
  });

  test('cartesia branch includes break tag guidance', () => {
    const result = buildVoiceModeInstructions('cartesia');
    expect(result).toContain('<break time=');
    expect(result).toContain('natural pauses');
  });

  test('cartesia branch includes spell tag guidance from shared capability contract', () => {
    const result = buildVoiceModeInstructions('cartesia');
    expect(result).toContain(CARTESIA_SONIC3_CAPABILITIES.ssml_tags.spell.form);
    expect(result).toContain('identifiers');
  });
  // === VIVENTIUM END ===
});

describe('buildWingModeInstructions', () => {
  const originalWingOverride = process.env.VIVENTIUM_WING_MODE_PROMPT;
  const originalShadowOverride = process.env.VIVENTIUM_SHADOW_MODE_PROMPT;

  afterEach(() => {
    if (originalWingOverride === undefined) {
      delete process.env.VIVENTIUM_WING_MODE_PROMPT;
    } else {
      process.env.VIVENTIUM_WING_MODE_PROMPT = originalWingOverride;
    }
    if (originalShadowOverride === undefined) {
      delete process.env.VIVENTIUM_SHADOW_MODE_PROMPT;
    } else {
      process.env.VIVENTIUM_SHADOW_MODE_PROMPT = originalShadowOverride;
    }
  });

  test('returns the built-in Wing Mode contract when no override is configured', () => {
    delete process.env.VIVENTIUM_WING_MODE_PROMPT;
    delete process.env.VIVENTIUM_SHADOW_MODE_PROMPT;

    const result = buildWingModeInstructions();

    expect(result).toContain('WING MODE:');
    expect(result).toContain(
      'A live call does not mean every spoken sentence is addressed to you;',
    );
    expect(result).toContain(
      'If you do not have a clear, useful, additive contribution, output exactly {NTA}.',
    );
    expect(result).toContain('output exactly {NTA}');
    expect(result).toContain('Err aggressively on the side of silence');
  });

  test('prefers the canonical Wing Mode env override when present', () => {
    process.env.VIVENTIUM_WING_MODE_PROMPT = 'Custom wing mode prompt.';

    expect(buildWingModeInstructions()).toBe('Custom wing mode prompt.');
  });

  test('falls back to the legacy shadow-mode env override when needed', () => {
    delete process.env.VIVENTIUM_WING_MODE_PROMPT;
    process.env.VIVENTIUM_SHADOW_MODE_PROMPT = 'Legacy shadow mode prompt.';

    expect(buildWingModeInstructions()).toBe('Legacy shadow mode prompt.');
  });
});

describe('isWingModeEnabledForRequest', () => {
  test('returns true for live voice calls when the persisted call session enables Wing Mode', () => {
    const req = {
      viventiumCallSession: {
        wingModeEnabled: true,
      },
    };

    expect(isWingModeEnabledForRequest(req, 'voice_call')).toBe(true);
  });

  test('falls back to the legacy shadow-mode alias on the call session', () => {
    const req = {
      viventiumCallSession: {
        shadowModeEnabled: true,
      },
    };

    expect(isWingModeEnabledForRequest(req, 'voice_call')).toBe(true);
  });

  test('returns false for non-call inputs even if the session flag is present', () => {
    const req = {
      viventiumCallSession: {
        wingModeEnabled: true,
      },
    };

    expect(isWingModeEnabledForRequest(req, 'voice_note')).toBe(false);
  });

  test('returns false when no persisted call session is available', () => {
    expect(isWingModeEnabledForRequest({}, 'voice_call')).toBe(false);
  });
});

/* === VIVENTIUM START ===
 * Feature: Telegram prompt must NOT request MarkdownV2
 * Purpose: The rendering pipeline uses HTML (markdown_to_html), not MarkdownV2.
 * Requesting MarkdownV2 causes models to emit backslash-escaped punctuation
 * (\. \- \!) that passes through the HTML renderer literally.
 * Root cause of: "You two look class\. best\-looking founders\."
 * Added: 2026-02-28
 * === VIVENTIUM END === */
describe('buildTelegramTextInstructions', () => {
  const originalOverride = process.env.VIVENTIUM_TELEGRAM_TEXT_MODE_PROMPT;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.VIVENTIUM_TELEGRAM_TEXT_MODE_PROMPT;
    } else {
      process.env.VIVENTIUM_TELEGRAM_TEXT_MODE_PROMPT = originalOverride;
    }
  });

  test('does NOT instruct to format AS MarkdownV2', () => {
    const result = buildTelegramTextInstructions();
    expect(result).not.toContain('Format for Telegram MarkdownV2');
    expect(result).not.toContain('Format for Telegram Markdown');
  });

  test('instructs standard Markdown formatting', () => {
    const result = buildTelegramTextInstructions();
    expect(result).toContain('standard Markdown');
  });

  test('explicitly prohibits MarkdownV2 backslash escaping', () => {
    const result = buildTelegramTextInstructions();
    expect(result).toMatch(/Do NOT use.*MarkdownV2.*escap/i);
  });

  test('still contains TELEGRAM TEXT MODE header', () => {
    const result = buildTelegramTextInstructions();
    expect(result).toContain('TELEGRAM TEXT MODE:');
  });
});

describe('buildWebTextInstructions', () => {
  const originalOverride = process.env.VIVENTIUM_WEB_TEXT_MODE_PROMPT;

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.VIVENTIUM_WEB_TEXT_MODE_PROMPT;
    } else {
      process.env.VIVENTIUM_WEB_TEXT_MODE_PROMPT = originalOverride;
    }
  });

  test('uses standard markdown rules for web text surfaces', () => {
    const result = buildWebTextInstructions();
    expect(result).toContain('WEB TEXT MODE:');
    expect(result).toContain('Use standard Markdown formatting');
    expect(result).toContain('Prefer short paragraphs and bullet lists');
    expect(result).not.toContain('MarkdownV2');
  });

  test('override env replaces default web rules', () => {
    process.env.VIVENTIUM_WEB_TEXT_MODE_PROMPT = 'Custom web output rules.';
    expect(buildWebTextInstructions()).toBe('Custom web output rules.');
  });
});

describe('buildTelegramAudioOutputInstructions', () => {
  test('Telegram text mode and audio output overlay can be combined without voice-call rules', () => {
    const telegramText = buildTelegramTextInstructions();
    const telegramAudio = buildTelegramAudioOutputInstructions('xai');
    const combined = [telegramText, telegramAudio].join('\n\n');

    expect(combined).toContain('TELEGRAM TEXT MODE:');
    expect(combined).toContain('TELEGRAM AUDIO OUTPUT:');
    expect(combined).toContain('Telegram text-mode answer');
    expect(combined).toContain('no markdown tables');
    expect(combined).not.toContain('VOICE CALL MODE:');
    expect(combined).not.toContain('No markdown, lists, or code blocks');
    expect(combined).not.toContain('Respond as spoken audio only');
  });

  test('xai branch keeps Telegram in text mode while exposing the xAI speech tag contract', () => {
    const result = buildTelegramAudioOutputInstructions('xai');
    expect(result).toContain('TELEGRAM AUDIO OUTPUT:');
    expect(result).toContain('Telegram text-mode answer');
    expect(result).toContain('xAI TTS is selected');
    expect(result).toContain('no markdown tables');
    expect(result).not.toContain('No markdown, lists, or code blocks');
    for (const tag of XAI_TTS_CAPABILITIES.speech_tags.inline) {
      expect(result).toContain(tag);
    }
    for (const tag of XAI_TTS_CAPABILITIES.speech_tags.wrapping) {
      expect(result).toContain(`<${tag}>TEXT</${tag}>`);
    }
    expect(result).toContain('Wrapping controls require angle brackets');
    expect(result).toContain('[tag]TEXT[/tag] is invalid');
    expect(result).toContain('without waiting for the user to ask');
    expect(result).toContain(
      'verify that the raw response contains at least one exact tag from the allowed xAI lists',
    );
    expect(result).toContain(
      'When an allowed tag fits, a plain draft is not final even when its words already convey tone',
    );
    expect(result).not.toContain('finish the raw response with one fitting exact allowed tag');
    expect(result).not.toContain('When the user explicitly asks for more emotion');
    expect(result).toContain('Do NOT use Cartesia-only controls');
  });

  test.each(['cartesia', 'xai', 'chatterbox', 'openai', 'unknown-provider'])(
    '%s audio output treats Feelings as a delivery cause while preserving natural restraint',
    (provider) => {
      const result = buildTelegramAudioOutputInstructions(provider);
      expect(result).toContain('If a <viventium_feeling_state> is present');
      expect(result).toContain(
        'silently appraise whether the current state and moment call for expressive or restrained delivery',
      );
      expect(result).toContain(
        'the raw voice-capable response is incomplete unless it contains a fitting documented control',
      );
      expect(result).toContain('Do not add voice controls merely to prove that a feeling exists');
      expect(result).toContain('unmarked speech is correct');
    },
  );

  test('cartesia branch exposes only documented Cartesia controls', () => {
    const result = buildTelegramAudioOutputInstructions('cartesia');
    expect(result).toContain(`Cartesia ${CARTESIA_SONIC3_CAPABILITIES.model_id} TTS is selected`);
    expect(result).toContain('Allowed emotion values:');
    expect(result).toContain('Allowed nonverbal marker from Cartesia docs: [laughter]');
    expect(result).toContain(CARTESIA_SONIC3_CAPABILITIES.ssml_tags.break.form);
    expect(result).toContain('Do NOT use xAI-only speech tags');
    expect(result).not.toContain('<emotion value="calm"/>');
    expect(result).not.toContain('<emotion value="excited">TEXT</emotion>');
    expect(result).not.toContain('<speed ratio="1.1"/>');
    expect(result).not.toContain('<volume ratio="0.9"/>');
    expect(result).not.toContain('<break time="1s"/>');
    expect(result).not.toContain('<spell>ABC123</spell>');
  });

  test('chatterbox branch limits bracketed nonverbal markers', () => {
    const result = buildTelegramAudioOutputInstructions('chatterbox');
    expect(result).toContain('Chatterbox TTS is selected');
    expect(result).toContain(
      TTS_PROVIDER_CAPABILITIES.providers.local_chatterbox_turbo_mlx_8bit.inline_controls.exact_tokens.join(
        ', ',
      ),
    );
    expect(result).toContain(
      'When delivery is expressive under the feeling-expression contract, include one allowed marker only when that marker naturally fits; when none fits or delivery is restrained, include none.',
    );
    expect(result).toContain('Do NOT invent other bracketed stage directions');
    expect(result).toContain('Do NOT use <emotion .../> tags');
  });

  test.each(['openai', 'elevenlabs'])(
    '%s branch keeps audio prompt plain text only',
    (provider) => {
      const result = buildTelegramAudioOutputInstructions(provider);
      expect(result).toContain('TELEGRAM AUDIO OUTPUT:');
      expect(result).toContain('Express tone and emotion through natural word choice');
      expect(result).toContain('Do NOT use <emotion .../> or any XML/SSML-like tags');
      expect(result).toContain('Do NOT use bracketed stage directions');
    },
  );

  test('unknown provider gets the generic audio-output overlay only', () => {
    const result = buildTelegramAudioOutputInstructions('unknown-provider');
    expect(result).toContain('TELEGRAM AUDIO OUTPUT:');
    expect(result).toContain('Telegram text-mode answer');
    expect(result).not.toContain('xAI TTS is selected');
    expect(result).not.toContain('Cartesia');
    expect(result).not.toContain('Chatterbox');
  });
});

describe('buildCortexOutputInstructions', () => {
  const requiredProvenanceRules = [
    'Do NOT claim a tool, worker, browser, email, file, or OS action happened unless this cortex actually received a verified tool result for that action in this run.',
    'If the main agent is already handling a direct tool/worker execution and you do not have independent verified results, output exactly {NTA}.',
    'Never fabricate tool-call transcripts, run ids, worker ids, or dispatch confirmations.',
  ];

  test('defaults non-voice, non-telegram, non-playground surfaces to markdown-friendly web output', () => {
    const result = buildCortexOutputInstructions({ voiceMode: false, surface: '', inputMode: '' });
    expect(result).toContain('Use standard Markdown formatting');
    expect(result).toContain('prefer short paragraphs and bullet lists');
  });

  test.each([
    ['default web', { voiceMode: false, surface: '', inputMode: '' }],
    ['voice surface', { voiceMode: true, surface: 'voice', inputMode: 'voice_note' }],
    ['telegram surface', { voiceMode: false, surface: 'telegram', inputMode: '' }],
    ['playground surface', { voiceMode: false, surface: 'playground', inputMode: '' }],
  ])('includes verified-action provenance rules for %s', (_label, args) => {
    const result = buildCortexOutputInstructions(args);
    expect(result).toContain('CORTEX OUTPUT RULES:');
    for (const rule of requiredProvenanceRules) {
      expect(result).toContain(rule);
    }
  });
});

describe('buildCortexOutputInstructions – telegram surface', () => {
  test('does NOT instruct MarkdownV2 for telegram surface', () => {
    const result = buildCortexOutputInstructions({ surface: 'telegram' });
    expect(result).not.toMatch(/Format for Telegram MarkdownV2/);
  });

  test('instructs standard Markdown for telegram surface', () => {
    const result = buildCortexOutputInstructions({ surface: 'telegram' });
    expect(result).toContain('standard Markdown');
  });

  test('mentions avoiding MarkdownV2 backslash escaping', () => {
    const result = buildCortexOutputInstructions({ surface: 'telegram' });
    expect(result).toMatch(/MarkdownV2.*escap/i);
  });

  test('keeps Telegram voice-note input in Telegram text-output mode', () => {
    const result = buildCortexOutputInstructions({
      voiceMode: false,
      surface: 'telegram',
      inputMode: 'voice_note',
    });
    expect(result).toContain('standard Markdown');
    expect(result).not.toContain('no markdown, no lists, no tables');
  });
});

/* === VIVENTIUM START ===
 * Feature: stripVoiceControlTagsForDisplay tests
 * Purpose: Verify that SSML tags and structural bracket stage directions are stripped
 * for display while preserving inner text content.
 * Added: 2026-02-22
 * === VIVENTIUM END === */
describe('stripVoiceControlTagsForDisplay', () => {
  test('strips self-closing emotion tags', () => {
    const result = stripVoiceControlTagsForDisplay('<emotion value="excited"/>Hello there.');
    expect(result).toBe('Hello there.');
    expect(result).not.toContain('<emotion');
  });

  test('strips wrapper emotion tags but preserves inner text', () => {
    const result = stripVoiceControlTagsForDisplay(
      '<emotion value="sad">Oh no</emotion> that is bad.',
    );
    expect(result).toBe('Oh no that is bad.');
  });

  test('strips bracket nonverbal markers', () => {
    const result = stripVoiceControlTagsForDisplay('[laughter] Hello [sigh] world');
    expect(result).not.toContain('[laughter]');
    expect(result).not.toContain('[sigh]');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  test('strips generic lowercase bracket stage directions', () => {
    const result = stripVoiceControlTagsForDisplay('Hello [smiles] world');
    expect(result).not.toContain('[smiles]');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  test('strips break, speed, volume tags', () => {
    const result = stripVoiceControlTagsForDisplay(
      'Hello <break time="1s"/> world <speed ratio="1.2"/>fast',
    );
    expect(result).not.toContain('<break');
    expect(result).not.toContain('<speed');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
    expect(result).toContain('fast');
  });

  test('strips spell tags but preserves inner text', () => {
    const result = stripVoiceControlTagsForDisplay(
      'The code is <spell>ABC123</spell> for reference.',
    );
    expect(result).toBe('The code is ABC123 for reference.');
  });

  test('returns empty string for null/undefined', () => {
    expect(stripVoiceControlTagsForDisplay(null)).toBe('');
    expect(stripVoiceControlTagsForDisplay(undefined)).toBe('');
    expect(stripVoiceControlTagsForDisplay('')).toBe('');
  });

  test('preserves plain text unchanged', () => {
    expect(stripVoiceControlTagsForDisplay('Just normal text.')).toBe('Just normal text.');
  });

  test('handles mixed SSML and bracket markers', () => {
    const result = stripVoiceControlTagsForDisplay(
      '<emotion value="excited"/>Hello! [laughter] How are you?',
    );
    expect(result).not.toContain('<emotion');
    expect(result).not.toContain('[laughter]');
    expect(result).toContain('Hello!');
    expect(result).toContain('How are you?');
  });

  // === VIVENTIUM START ===
  // Feature: xAI [whisper] marker parity test (added 2026-02-22)
  test('strips [whisper] marker (xAI vocabulary)', () => {
    const result = stripVoiceControlTagsForDisplay('Hello [whisper] secrets');
    expect(result).not.toContain('[whisper]');
    expect(result).toContain('Hello');
    expect(result).toContain('secrets');
  });

  test('strips xai wrapping tags while preserving inner text', () => {
    const result = stripVoiceControlTagsForDisplay(
      'I need <whisper>this part quiet</whisper> and <slow><soft>this part gentle</soft></slow>.',
    );
    expect(result).toBe('I need this part quiet and this part gentle.');
    expect(result).not.toContain('<whisper>');
    expect(result).not.toContain('<slow>');
    expect(result).not.toContain('<soft>');
  });

  test('strips malformed xai square wrapper tags', () => {
    const result = stripVoiceControlTagsForDisplay(
      '<soft>Morning. You have warmth.[/soft] If needed.',
    );
    expect(result).toBe('Morning. You have warmth. If needed.');
    expect(result).not.toContain('<soft>');
    expect(result).not.toContain('[/soft]');
  });

  test('preserves non-stage bracket text', () => {
    expect(stripVoiceControlTagsForDisplay('Choose [A] or [ok] for the label.')).toBe(
      'Choose [A] or [ok] for the label.',
    );
  });

  test('strips markdown emphasis markers while preserving words', () => {
    expect(stripVoiceControlTagsForDisplay('**bold** _italic_ *** rule *** Done')).toBe(
      'bold italic rule Done',
    );
  });

  test('strips citation, source, and link artifacts for voice display persistence', () => {
    const result = stripVoiceControlTagsForDisplay(
      'Sources: https://example.com/report Read [brief](https://example.com/brief). Email qa@example.com. Answer [12].',
    );
    expect(result).toBe('link available Read brief. Email address available. Answer.');
    expect(result).not.toMatch(/\b([A-Za-z][A-Za-z']{1,})\b[\s.,!?;:]+\1\b/i);
    expect(result).not.toContain('Sources:');
    expect(result).not.toContain('https://');
    expect(result).not.toContain('[12]');
  });

  test('preserves math multiplication instead of treating it as emphasis', () => {
    expect(stripVoiceControlTagsForDisplay('Five times three is 5 * 3.')).toBe(
      'Five times three is 5 * 3.',
    );
  });

  test('preserves dot-heavy technical tokens while spacing normal sentences', () => {
    expect(
      stripVoiceControlTagsForDisplay('Use .NET, asp.net, v1.2A, U.S.A., and node.js. Done.Next.'),
    ).toBe('Use .NET, asp.net, v1.2A, U.S.A., and node.js. Done. Next.');
  });

  test('strips malformed no-response artifacts without stripping template variables', () => {
    expect(stripVoiceControlTagsForDisplay('Useful {N{NTATA}} context {N{N{NTA}}} ${NTA}')).toBe(
      'Useful context ${NTA}',
    );
  });

  test('exports explicit voice surface sanitizer alias', () => {
    expect(sanitizeVoiceSurfaceTextForDisplay('<custom>Hi</custom> **there**')).toBe('Hi there');
  });
  // === VIVENTIUM END ===
});
