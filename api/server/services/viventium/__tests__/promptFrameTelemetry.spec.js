/* === VIVENTIUM START ===
 * Tests: Prompt-frame telemetry metadata/redaction contract.
 * Added: 2026-05-07
 * === VIVENTIUM END === */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LOG_ENV,
  DEBUG_ENV,
  DEBUG_LOCAL_ENV,
  FILE_LOG_ENV,
  OBSERVABILITY_DIR_ENV,
  estimatePromptTokens,
  hashString,
  hashFile,
  redactPromptDebugText,
  countVoiceControlMarkers,
  summarizeLayers,
  PROMPT_FRAME_LAYERS,
  normalizeLayersToContract,
  normalizeMCPInstructionSources,
  buildPromptFrame,
  buildPromptFrameRequestIdentityHash,
  buildPromptFrameRouteTelemetry,
  buildPromptFrameTraceTelemetry,
  promptLayerIntegritySnapshot,
  resetPromptLayerIntegrityForTests,
  logPromptFrame,
  writePromptFrameFile,
  flushPromptFrameFileWrites,
} = require('../promptFrameTelemetry');

describe('promptFrameTelemetry', () => {
  const originalEnv = {
    [LOG_ENV]: process.env[LOG_ENV],
    [DEBUG_ENV]: process.env[DEBUG_ENV],
    [DEBUG_LOCAL_ENV]: process.env[DEBUG_LOCAL_ENV],
    [FILE_LOG_ENV]: process.env[FILE_LOG_ENV],
    [OBSERVABILITY_DIR_ENV]: process.env[OBSERVABILITY_DIR_ENV],
    VIVENTIUM_PROMPT_BUNDLE_PATH: process.env.VIVENTIUM_PROMPT_BUNDLE_PATH,
    CONFIG_PATH: process.env.CONFIG_PATH,
    CI: process.env.CI,
  };

  afterEach(() => {
    resetPromptLayerIntegrityForTests();
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  test('tracks unknown prompt layers locally without storing prompt text', () => {
    expect(promptLayerIntegritySnapshot()).toEqual({
      contractVersion: 1,
      unknownLayerNames: [],
    });

    buildPromptFrame({
      promptFamily: 'main_runtime',
      layers: {
        main_context_snapshot: 'private current-turn text',
        future_unregistered_layer: 'private unknown text',
      },
    });

    const snapshot = promptLayerIntegritySnapshot();
    expect(snapshot).toEqual({
      contractVersion: 1,
      unknownLayerNames: ['future_unregistered_layer'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private');
  });

  test('registers both Workbench surface prompt producers', () => {
    buildPromptFrame({
      promptFamily: 'main_runtime',
      layers: {
        workbench_text: 'interactive Workbench instructions',
        scheduled_canonical_output: 'scheduled canonical output instructions',
      },
    });

    expect(promptLayerIntegritySnapshot()).toEqual({
      contractVersion: 1,
      unknownLayerNames: [],
    });
  });

  test('redacts private prompt debug values without classifying user intent', () => {
    const userHome = '/' + ['Users', 'someone'].join('/');
    const linuxHome = '/' + ['home', 'someone', '.config', 'viventium', 'private.log'].join('/');
    const ownerEmail = ['owner', 'example.com'].join('@');
    const apiKey = 'sk' + '-' + 'testsecret123456';
    const bearerSecret = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
    const text = [
      `User: ${ownerEmail}`,
      `Path: ${userHome}/Documents/Viventium/private.txt`,
      `App Support: ${userHome}/Library/Application Support/Viventium/state/runtime/logs/api.log`,
      `Linux: ${linuxHome}`,
      'Temp: /tmp/viventium/private.log',
      'Windows: C:\\Users\\someone\\AppData\\Local\\Viventium\\private.log',
      'UNC: \\\\HOST\\Share\\Viventium\\private.log',
      `Auth: ${bearerSecret}`,
      `API: api_key=${apiKey}`,
      'UUID: 6a078d96-6884-4b3b-ae6a-456d4b9a3e31',
      'ObjectId: 661e2c7189abcdef01234567',
      'Telegram: 1234567890123',
    ].join('\n');

    const redacted = redactPromptDebugText(text);
    expect(redacted).not.toContain(ownerEmail);
    expect(redacted).not.toContain(userHome);
    expect(redacted).not.toContain('Application Support');
    expect(redacted).not.toContain(linuxHome);
    expect(redacted).not.toContain('/tmp/viventium');
    expect(redacted).not.toContain('C:\\Users');
    expect(redacted).not.toContain('\\\\HOST');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain(apiKey);
    expect(redacted).not.toContain('6a078d96-6884-4b3b-ae6a-456d4b9a3e31');
    expect(redacted).not.toContain('661e2c7189abcdef01234567');
    expect(redacted).not.toContain('1234567890123');
    expect(redacted).toContain('[email]');
    expect(redacted).toContain('[local_path]');
    expect(redacted).toContain('Bearer [secret]');
    expect(redacted).toContain('api_key=[secret]');
    expect(redacted).toContain('[uuid]');
    expect(redacted).toContain('[object_id]');
    expect(redacted).toContain('[numeric_id]');
  });

  test('summarizes layer tokens and hashes without returning raw text', () => {
    const layers = {
      main: 'System prompt with private content',
      followup: 'Another layer',
    };

    const summary = summarizeLayers(layers);
    expect(summary.token_estimates.main).toBeGreaterThan(0);
    expect(summary.char_counts.followup).toBe('Another layer'.length);
    expect(summary.hashes.main).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(summary)).not.toContain('System prompt with private content');
  });

  test('builds separate source, compiled, live, and file hashes', () => {
    delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-prompt-frame-'));
    const sourceFile = path.join(tempDir, 'source.yaml');
    const runtimeConfigFile = path.join(tempDir, 'librechat.generated.yaml');
    fs.writeFileSync(sourceFile, 'instructions: test\n', 'utf8');
    fs.writeFileSync(runtimeConfigFile, 'version: 1.2.3\n', 'utf8');
    process.env.CONFIG_PATH = runtimeConfigFile;
    const libreChatRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const sourceOfTruthRoot = path.join(libreChatRoot, 'viventium', 'source_of_truth');

    const frame = buildPromptFrame({
      promptFamily: 'main_runtime',
      surface: 'telegram',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      layers: {
        system: 'hello',
      },
      sourceHashes: {
        source: 'sourcehash',
        compiled: 'compiledhash',
        live: 'livehash',
      },
      promptSourceFiles: {
        source_yaml: sourceFile,
      },
    });

    expect(frame.source_hashes).toEqual({
      source: 'sourcehash',
      compiled: 'compiledhash',
      live: 'livehash',
      agent_source: hashFile(path.join(sourceOfTruthRoot, 'local.viventium-agents.yaml')),
      librechat_source: hashFile(path.join(sourceOfTruthRoot, 'local.librechat.yaml')),
      compiled_runtime_config: hashFile(runtimeConfigFile),
      live_installed_runtime_config: hashFile(runtimeConfigFile),
      compiler_version: 'missing',
    });
    expect(frame.prompt_source_file_hashes.source_yaml).toBe(hashFile(sourceFile));
    expect(JSON.stringify(frame)).not.toContain(sourceFile);
  });

  test('normalizes prompt frame layers to the documented contract', () => {
    const normalized = normalizeLayersToContract({
      primary_final_instructions: 'main text',
      instructions_before_surface_injection: 'pre surface text',
      primary_run_instructions: 'run text',
      viventium_user_fact_guard: 'fact guard',
      background_cortex_runtime_card_guard: 'cortex card guard',
      no_response_instructions: 'nta text',
      formatted_input_messages: [{ role: 'user', content: 'message context' }],
      telegram_text: 'surface text',
      telegram_audio_output: 'telegram audio expression text',
      telegram_reply_context: 'reply identity',
      voice_gateway_insight_instructions: 'voice insight',
      active_work_context: 'active work',
      rapid_source_selection: 'source selection',
      main_continuity: 'continuity',
      main_context_snapshot: 'snapshot digest',
      recurrence_state: 'recurrence',
      activation_prompt: 'activate',
      cortex_instructions: 'execute',
      productivity_runtime_instructions: 'productivity runtime',
      file_context: 'file evidence',
      cortex_output_rules: 'output rules',
      recent_response: 'already said',
      user_request: 'current request',
      unexpected_local_key: 'private shape',
    });

    expect(PROMPT_FRAME_LAYERS).toContain('main_instructions');
    expect(normalized.layers.main_instructions).toContain('main text');
    expect(normalized.layers.main_instructions).toContain('pre surface text');
    expect(normalized.layers.main_instructions).toContain('run text');
    expect(normalized.layers.main_instructions).toContain('fact guard');
    expect(normalized.layers.main_instructions).toContain('cortex card guard');
    expect(normalized.layers.global_no_response).toContain('nta text');
    expect(normalized.layers.background_context).toContain('message context');
    expect(normalized.layers.background_context).toContain('file evidence');
    expect(normalized.layers.background_context).toContain('active work');
    expect(normalized.layers.background_context).toContain('snapshot digest');
    expect(normalized.layers.surface_prompt).toContain('surface text');
    expect(normalized.layers.surface_prompt).toContain('telegram audio expression text');
    expect(normalized.layers.surface_prompt).toContain('reply identity');
    expect(normalized.layers.surface_prompt).toContain('voice insight');
    expect(normalized.layers.cortex_activation).toContain('activate');
    expect(normalized.layers.cortex_execution).toContain('execute');
    expect(normalized.layers.cortex_execution).toContain('productivity runtime');
    expect(normalized.layers.cortex_execution).toContain('output rules');
    expect(normalized.layers.followup).toContain('already said');
    expect(normalized.layers.followup).toContain('current request');
    expect(normalized.unknown_layer_names).toEqual(['unexpected_local_key']);

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: normalized.layers,
    });
    expect(Object.keys(frame.layer_token_estimates)).toEqual(PROMPT_FRAME_LAYERS);
    expect(frame.layer_contract_version).toBe(1);
  });

  test('counts voice provider-control markers', () => {
    const counts = countVoiceControlMarkers(
      '[warm] [NTA] [email] [uuid] Hello <break time="300ms"/> <prosody rate="slow">now</prosody> <say-as interpret-as="characters">AI</say-as>',
    );

    expect(counts.break_tags).toBe(1);
    expect(counts.prosody_tags).toBe(2);
    expect(counts.say_as_tags).toBe(2);
    expect(counts.emotion_tags).toBe(1);
    expect(counts.total).toBe(6);
  });

  test('records MCP instruction source metadata without raw prompt text', () => {
    const sources = normalizeMCPInstructionSources({
      scheduling: 'server_fetched',
      glasshive: 'config_inline',
      broken: 'unexpected',
      'bad key with spaces': 'server_fetched',
    });

    expect(sources).toEqual({
      scheduling: 'server_fetched',
      glasshive: 'config_inline',
      broken: 'missing',
      bad_key_with_spaces: 'server_fetched',
    });

    const frame = buildPromptFrame({
      promptFamily: 'main_assembly',
      layers: {
        mcp_server_instructions: 'Private MCP instruction text',
      },
      mcpInstructionSources: sources,
    });
    expect(frame.mcp_instruction_sources).toEqual(sources);
    expect(JSON.stringify(frame.mcp_instruction_sources)).not.toContain(
      'Private MCP instruction text',
    );
  });

  test('debug redacted layers require both debug and local gates', () => {
    process.env[DEBUG_ENV] = '1';
    delete process.env[DEBUG_LOCAL_ENV];
    const ownerEmail = ['owner', 'example.com'].join('@');

    let frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: ownerEmail,
      },
    });
    expect(frame.debug_redacted_layers).toBeUndefined();

    process.env[DEBUG_LOCAL_ENV] = '1';
    frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: ownerEmail,
      },
    });
    expect(frame.debug_redacted_layers.unknown).toContain('[email]');
  });

  test('local debug layer limit can hold full assembled prompt evidence', () => {
    process.env[DEBUG_ENV] = '1';
    process.env[DEBUG_LOCAL_ENV] = '1';
    process.env.VIVENTIUM_PROMPT_FRAME_DEBUG_CHAR_LIMIT = '200000';
    const longPrompt = 'A'.repeat(80_000);

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        main_instructions: longPrompt,
      },
    });

    expect(frame.debug_redacted_layers.main_instructions).toHaveLength(longPrompt.length);
    expect(frame.debug_redacted_layers.main_instructions).not.toContain('[truncated]');
  });

  test('logging can be disabled and never mutates frame shape', () => {
    const logger = {
      info: jest.fn(),
      debug: jest.fn(),
    };
    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: 'hello',
      },
    });

    process.env[LOG_ENV] = '0';
    expect(logPromptFrame(logger, frame)).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();

    process.env[LOG_ENV] = '1';
    expect(logPromptFrame(logger, frame)).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).not.toContain('hello');
    expect(logger.debug.mock.calls[0].join(' ')).not.toContain('hello');
  });

  test.each([
    ['Main', 'agent_viventium_main_synthetic'],
    ['specialist', 'agent_viventium_specialist_synthetic'],
  ])('binds the actual %s agent to public-safe provider-frame telemetry', (_kind, agentId) => {
    const expectedAgentIdHash = crypto
      .createHash('sha256')
      .update(agentId)
      .digest('hex')
      .slice(0, 16);
    const frame = buildPromptFrame({
      promptFamily: 'main_run_create',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      agentId,
      layers: { main_instructions: 'private prompt content' },
    });
    const route = buildPromptFrameRouteTelemetry(frame);

    expect(frame.agent_id_hash).toBe(expectedAgentIdHash);
    expect(route.a).toBe(expectedAgentIdHash);
    expect(JSON.stringify(frame)).not.toContain(agentId);
    expect(JSON.stringify(route)).not.toContain(agentId);
    expect(JSON.stringify(route)).not.toContain('private prompt content');
  });

  test('binds prompt frames to the exact authenticated owner and trusted source event', () => {
    const ownerId = 'private-owner-id';
    const interactionContext = {
      surface: 'telegram',
      source_event_id: 'private-source-event-id',
    };
    const expected = crypto
      .createHash('sha256')
      .update(
        [
          'viventium.prompt-frame-request.v1',
          ownerId,
          interactionContext.surface,
          interactionContext.source_event_id,
        ].join('\0'),
      )
      .digest('hex')
      .slice(0, 16);

    const frame = buildPromptFrame({
      promptFamily: 'main_run_create',
      surface: 'telegram',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      requestIdentity: { ownerId, interactionContext },
    });
    const route = buildPromptFrameRouteTelemetry(frame);

    expect(buildPromptFrameRequestIdentityHash({ ownerId, interactionContext })).toBe(expected);
    expect(frame.request_identity_hash).toBe(expected);
    expect(route.q).toBe(expected);
    expect(route.s).toBe('telegram');
    expect(JSON.stringify(frame)).not.toContain(ownerId);
    expect(JSON.stringify(frame)).not.toContain(interactionContext.source_event_id);
    expect(JSON.stringify(route)).not.toContain(ownerId);
    expect(JSON.stringify(route)).not.toContain(interactionContext.source_event_id);
  });

  test('does not invent request identity without both authenticated owner and trusted source', () => {
    expect(
      buildPromptFrameRequestIdentityHash({
        ownerId: '',
        interactionContext: { surface: 'telegram', source_event_id: 'source-event' },
      }),
    ).toBe('missing');
    expect(
      buildPromptFrameRequestIdentityHash({
        ownerId: 'owner-id',
        interactionContext: { surface: 'telegram', source_event_id: '' },
      }),
    ).toBe('missing');
  });

  test('does not invent an executed agent from missing, short, or conflicting identities', () => {
    const missing = buildPromptFrame({ promptFamily: 'main_run_create' });
    const short = buildPromptFrame({
      promptFamily: 'cortex_execution',
      decisionState: { agent_id_hash: hashString('agent_synthetic', 12) },
    });
    const conflicting = buildPromptFrame({
      promptFamily: 'main_run_create',
      agentId: 'agent_actual_synthetic',
      decisionState: { agent_id_hash: hashString('agent_other_synthetic') },
    });

    expect(missing.agent_id_hash).toBe('missing');
    expect(short.agent_id_hash).toBe('missing');
    expect(conflicting.agent_id_hash).toBe('missing');
    expect(buildPromptFrameRouteTelemetry(missing).a).toBe('missing');
    expect(buildPromptFrameRouteTelemetry(short).a).toBe('missing');
    expect(buildPromptFrameRouteTelemetry(conflicting).a).toBe('missing');
  });

  test('accepts only a complete existing trusted decision-state agent hash', () => {
    const agentIdHash = hashString('agent_synthetic_background');
    const frame = buildPromptFrame({
      promptFamily: 'cortex_execution',
      decisionState: { agent_id_hash: agentIdHash },
    });

    expect(frame.agent_id_hash).toBe(agentIdHash);
    expect(buildPromptFrameRouteTelemetry(frame).a).toBe(agentIdHash);
  });

  test('normal logger emits bounded route and strict trace metadata only', () => {
    const logger = { info: jest.fn(), debug: jest.fn() };
    process.env[LOG_ENV] = '1';
    const frame = buildPromptFrame({
      promptFamily: 'main_run_create',
      surface: 'web',
      requestedProvider: 'glasshive-harness',
      requestedModel: 'codex-cli:synthetic-model',
      requestedEffort: 'medium',
      provider: 'glasshive-harness',
      model: 'codex-cli:synthetic-model',
      reasoningEffort: 'medium',
      layers: { main_instructions: 'private prompt text'.repeat(500) },
    });

    expect(logPromptFrame(logger, frame)).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const routeLine = logger.info.mock.calls[0][0];
    expect(routeLine).toMatch(/^\[PromptFrameRouteTelemetry\] /);
    expect(routeLine.length).toBeLessThanOrEqual(256);
    expect(routeLine).not.toContain('glasshive-harness');
    expect(routeLine).not.toContain('synthetic-model');
    expect(routeLine).not.toContain('private prompt text');
    const route = JSON.parse(routeLine.replace(/^\[PromptFrameRouteTelemetry\] /, ''));
    expect(route).toEqual([
      2,
      'main_run_create',
      'web',
      hashString('glasshive-harness'),
      hashString('codex-cli:synthetic-model'),
      'medium',
      hashString('glasshive-harness'),
      hashString('codex-cli:synthetic-model'),
      'medium',
      0,
      'none',
      'missing',
      'missing',
    ]);
    const traceLine = logger.debug.mock.calls[0].join(' ');
    expect(traceLine).toMatch(/^\[PromptFrameTraceTelemetry\] /);
    expect(Buffer.byteLength(traceLine)).toBeLessThanOrEqual(8192);
    const trace = JSON.parse(traceLine.replace(/^\[PromptFrameTraceTelemetry\] /, ''));
    expect(trace).toEqual(
      buildPromptFrameTraceTelemetry(frame, { now: () => new Date(trace.time) }),
    );
    expect(trace.provider).toBe(`h${hashString('glasshive-harness')}`);
    expect(trace.model).toBe(`h${hashString('codex-cli:synthetic-model')}`);
    expect(trace.requested_effort).toBe('medium');
    expect(trace.effective_effort).toBe('medium');
    expect(trace.fallback_used).toBe(false);
    expect(trace.fallback_reason).toBe('none');
    expect(trace.layer_tokens.main_instructions).toBeGreaterThan(0);
  });

  test('emits only typed fallback lineage and fails missing effort closed', () => {
    const valid = buildPromptFrame({
      promptFamily: 'main_run_create',
      requestedProvider: 'synthetic-primary-provider',
      requestedModel: 'synthetic-primary-model',
      requestedEffort: 'medium',
      provider: 'synthetic-fallback-provider',
      model: 'synthetic-fallback-model',
      reasoningEffort: 'high',
      fallbackUsed: true,
      fallbackReason: 'provider_timeout',
    });
    const missing = buildPromptFrame({
      promptFamily: 'main_run_create',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      fallbackUsed: true,
      fallbackReason: 'raw private provider message',
    });

    expect(valid.requested_effort).toBe('medium');
    expect(valid.effective_effort).toBe('high');
    expect(valid.fallback_reason).toBe('provider_timeout');
    expect(buildPromptFrameRouteTelemetry(valid)).toMatchObject({
      v: 2,
      re: 'medium',
      ee: 'high',
      fu: true,
      fr: 'provider_timeout',
    });
    expect(missing.requested_effort).toBe('missing');
    expect(missing.effective_effort).toBe('missing');
    expect(missing.fallback_reason).toBe('missing');
    expect(JSON.stringify(missing)).not.toContain('raw private provider message');
  });

  test('normal logger rejects unknown fields and hashes all allowed string metadata', () => {
    const logger = {
      info: jest.fn(),
      debug: jest.fn(),
    };
    process.env[DEBUG_ENV] = '1';
    process.env[DEBUG_LOCAL_ENV] = '1';
    process.env[LOG_ENV] = '1';

    const frame = buildPromptFrame({
      promptFamily: 'main_runtime',
      surface: 'web',
      layers: {
        main_instructions: 'private prompt text',
      },
      flags: { input_mode: 'private input mode', private_note: 'private flag text' },
      decisionState: {
        status: 'private status text',
        reason_code: 'private reason text',
        private_note: 'private decision text',
      },
    });
    frame.raw_transcript = 'private transcript text';

    expect(frame.debug_redacted_layers.main_instructions).toContain('private prompt text');
    expect(logPromptFrame(logger, frame)).toBe(true);
    const traceLine = logger.debug.mock.calls[0].join(' ');
    for (const privateText of [
      'debug_redacted_layers',
      'private prompt text',
      'private input mode',
      'private flag text',
      'private status text',
      'private reason text',
      'private decision text',
      'private transcript text',
      'private_note',
      'raw_transcript',
    ]) {
      expect(traceLine).not.toContain(privateText);
    }
    const trace = JSON.parse(traceLine.replace(/^\[PromptFrameTraceTelemetry\] /, ''));
    expect(trace.flags.input_mode_hash).toBe(hashString('private input mode'));
    expect(trace.decision.status_hash).toBe(hashString('private status text'));
    expect(trace.decision.reason_code_hash).toBe(hashString('private reason text'));
  });

  test('token estimate is monotonic with prompt size', () => {
    expect(estimatePromptTokens('abcd')).toBeLessThan(estimatePromptTokens('abcd'.repeat(10)));
  });

  test('legacy direct file logging remains disabled even when explicitly requested', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-prompt-observability-'));
    process.env[FILE_LOG_ENV] = '1';
    process.env[OBSERVABILITY_DIR_ENV] = tempDir;
    process.env.CI = '';

    const frame = buildPromptFrame({
      promptFamily: 'test',
      surface: 'web',
      layers: {
        raw: 'hello',
      },
    });

    expect(writePromptFrameFile(frame)).toBe(false);
    await expect(flushPromptFrameFileWrites()).resolves.toBe(true);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  test('local file logging refuses CI mode', () => {
    process.env[FILE_LOG_ENV] = '1';
    process.env.CI = 'true';

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: 'hello',
      },
    });

    expect(writePromptFrameFile(frame)).toBe(false);
  });
});
